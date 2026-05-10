/* oxlint-disable max-lines -- Why: this App-level IPC bridge intentionally keeps the renderer's main-process event contract in one place so shortcut, runtime, updater, and agent-status wiring do not drift across files. */
import { useEffect } from 'react'
import { useAppStore } from '../store'
import { applyUIZoom } from '@/lib/ui-zoom'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { runSleepWorktree } from '@/components/sidebar/sleep-worktree-flow'
import { SPLIT_TERMINAL_PANE_EVENT, CLOSE_TERMINAL_PANE_EVENT } from '@/constants/terminal'
import type { SplitTerminalPaneDetail, CloseTerminalPaneDetail } from '@/constants/terminal'
import { getVisibleWorktreeIds } from '@/components/sidebar/visible-worktrees'
import { nextEditorFontZoomLevel, computeEditorFontSize } from '@/lib/editor-font-zoom'
import type { UpdateStatus, WorkspaceSessionState } from '../../../shared/types'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { zoomLevelToPercent, ZOOM_MIN, ZOOM_MAX } from '@/components/settings/SettingsConstants'
import { dispatchZoomLevelChanged } from '@/lib/zoom-events'
import { resolveZoomTarget } from './resolve-zoom-target'
import {
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from './ipc-tab-switch'
import { normalizeAgentStatusPayload } from '../../../shared/agent-status-types'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { setFitOverride, hydrateOverrides } from '@/lib/pane-manager/mobile-fit-overrides'
import { setDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { destroyPersistentWebview } from '@/components/browser-pane/webview-registry'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { runDuringRemoteWorkspaceHydration } from '@/lib/remote-workspace-hydration-guard'

export { resolveZoomTarget } from './resolve-zoom-target'

const ZOOM_STEP = 0.5

function getWorktreePathFromId(worktreeId: string): string | null {
  const separatorIdx = worktreeId.indexOf('::')
  return separatorIdx >= 0 ? worktreeId.slice(separatorIdx + 2) : null
}

function remapWorktreeRecord<T>(
  input: Record<string, T> | undefined,
  mapWorktreeId: (worktreeId: string) => string | null
): Record<string, T> | undefined {
  if (!input) {
    return undefined
  }
  const entries = Object.entries(input)
    .map(([worktreeId, value]) => {
      const mapped = mapWorktreeId(worktreeId)
      return mapped ? ([mapped, value] as const) : null
    })
    .filter((entry): entry is readonly [string, T] => entry !== null)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function translateRemoteWorkspaceSessionIds(
  targetId: string,
  session: WorkspaceSessionState
): WorkspaceSessionState {
  const store = useAppStore.getState()
  const remoteRepos = store.repos.filter((repo) => repo.connectionId === targetId)
  const validLocalRepoIds = new Set(remoteRepos.map((repo) => repo.id))
  const worktreeIdByPath = new Map<string, string>()
  for (const repo of remoteRepos) {
    for (const worktree of store.worktreesByRepo[repo.id] ?? []) {
      worktreeIdByPath.set(worktree.path, worktree.id)
    }
  }

  const mapWorktreeId = (worktreeId: string): string | null => {
    const repoId = worktreeId.split('::')[0]
    if (validLocalRepoIds.has(repoId)) {
      return worktreeId
    }
    const path = getWorktreePathFromId(worktreeId)
    return path ? (worktreeIdByPath.get(path) ?? null) : null
  }

  const mapWorktreeIds = (ids: string[] | undefined): string[] | undefined => {
    const mapped = (ids ?? []).map(mapWorktreeId).filter((id): id is string => id !== null)
    return mapped.length > 0 ? mapped : undefined
  }

  const tabsByWorktree = remapWorktreeRecord(session.tabsByWorktree, mapWorktreeId) as
    | WorkspaceSessionState['tabsByWorktree']
    | undefined
  const normalizedTabsByWorktree = Object.fromEntries(
    Object.entries(tabsByWorktree ?? {}).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => ({ ...tab, worktreeId }))
    ])
  )
  const browserTabsByWorktree = remapWorktreeRecord(
    session.browserTabsByWorktree,
    mapWorktreeId
  ) as WorkspaceSessionState['browserTabsByWorktree']
  const normalizedBrowserTabsByWorktree = browserTabsByWorktree
    ? Object.fromEntries(
        Object.entries(browserTabsByWorktree).map(([worktreeId, tabs]) => [
          worktreeId,
          tabs.map((tab) => ({ ...tab, worktreeId }))
        ])
      )
    : undefined
  const unifiedTabs = remapWorktreeRecord(session.unifiedTabs, mapWorktreeId) as
    | WorkspaceSessionState['unifiedTabs']
    | undefined
  const normalizedUnifiedTabs = unifiedTabs
    ? Object.fromEntries(
        Object.entries(unifiedTabs).map(([worktreeId, tabs]) => [
          worktreeId,
          tabs.map((tab) => ({ ...tab, worktreeId }))
        ])
      )
    : undefined
  const tabGroups = remapWorktreeRecord(session.tabGroups, mapWorktreeId) as
    | WorkspaceSessionState['tabGroups']
    | undefined
  const normalizedTabGroups = tabGroups
    ? Object.fromEntries(
        Object.entries(tabGroups).map(([worktreeId, groups]) => [
          worktreeId,
          groups.map((group) => ({ ...group, worktreeId }))
        ])
      )
    : undefined
  const activeWorktreeId = session.activeWorktreeId ? mapWorktreeId(session.activeWorktreeId) : null
  const activeRepoId = activeWorktreeId
    ? activeWorktreeId.split('::')[0]
    : session.activeRepoId && validLocalRepoIds.has(session.activeRepoId)
      ? session.activeRepoId
      : null
  const openFilesByWorktree = remapWorktreeRecord(
    session.openFilesByWorktree,
    mapWorktreeId
  ) as WorkspaceSessionState['openFilesByWorktree']
  const normalizedOpenFilesByWorktree = openFilesByWorktree
    ? Object.fromEntries(
        Object.entries(openFilesByWorktree).map(([worktreeId, files]) => [
          worktreeId,
          files.map((file) => ({ ...file, worktreeId }))
        ])
      )
    : undefined

  return {
    ...session,
    activeRepoId,
    activeWorktreeId,
    tabsByWorktree: normalizedTabsByWorktree,
    activeWorktreeIdsOnShutdown: mapWorktreeIds(session.activeWorktreeIdsOnShutdown),
    openFilesByWorktree: normalizedOpenFilesByWorktree,
    activeFileIdByWorktree: remapWorktreeRecord(session.activeFileIdByWorktree, mapWorktreeId),
    browserTabsByWorktree: normalizedBrowserTabsByWorktree,
    browserPagesByWorkspace: session.browserPagesByWorkspace
      ? Object.fromEntries(
          Object.entries(session.browserPagesByWorkspace)
            .map(([workspaceId, pages]) => {
              const mappedPages = pages
                .map((page) => {
                  const worktreeId = mapWorktreeId(page.worktreeId)
                  return worktreeId ? { ...page, worktreeId } : null
                })
                .filter((page): page is NonNullable<typeof page> => page !== null)
              return mappedPages.length > 0 ? ([workspaceId, mappedPages] as const) : null
            })
            .filter(
              (entry): entry is readonly [string, NonNullable<typeof entry>[1]] => entry !== null
            )
        )
      : undefined,
    activeBrowserTabIdByWorktree: remapWorktreeRecord(
      session.activeBrowserTabIdByWorktree,
      mapWorktreeId
    ),
    activeTabTypeByWorktree: remapWorktreeRecord(session.activeTabTypeByWorktree, mapWorktreeId),
    activeTabIdByWorktree: remapWorktreeRecord(session.activeTabIdByWorktree, mapWorktreeId),
    unifiedTabs: normalizedUnifiedTabs,
    tabGroups: normalizedTabGroups,
    tabGroupLayouts: remapWorktreeRecord(session.tabGroupLayouts, mapWorktreeId),
    activeGroupIdByWorktree: remapWorktreeRecord(session.activeGroupIdByWorktree, mapWorktreeId),
    activeConnectionIdsAtShutdown: [targetId],
    lastVisitedAtByWorktreeId: remapWorktreeRecord(session.lastVisitedAtByWorktreeId, mapWorktreeId)
  }
}

type RemoteWorkspaceTargetScope = {
  repoIds: Set<string>
  worktreeIds: Set<string>
}

export function mergeRemoteWorkspaceSession(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  targetScope: RemoteWorkspaceTargetScope = { repoIds: new Set(), worktreeIds: new Set() }
): WorkspaceSessionState {
  const remoteWorktreeIds = new Set([
    ...(remote.activeWorktreeId ? [remote.activeWorktreeId] : []),
    ...Object.keys(remote.tabsByWorktree ?? {}),
    ...(remote.activeWorktreeIdsOnShutdown ?? []),
    ...Object.keys(remote.openFilesByWorktree ?? {}),
    ...Object.keys(remote.activeFileIdByWorktree ?? {}),
    ...Object.keys(remote.browserTabsByWorktree ?? {}),
    ...Object.keys(remote.activeBrowserTabIdByWorktree ?? {}),
    ...Object.keys(remote.activeTabTypeByWorktree ?? {}),
    ...Object.keys(remote.activeTabIdByWorktree ?? {}),
    ...Object.keys(remote.unifiedTabs ?? {}),
    ...Object.keys(remote.tabGroups ?? {}),
    ...Object.keys(remote.tabGroupLayouts ?? {}),
    ...Object.keys(remote.activeGroupIdByWorktree ?? {}),
    ...Object.keys(remote.lastVisitedAtByWorktreeId ?? {}),
    ...Object.values(remote.browserPagesByWorkspace ?? {})
      .flat()
      .map((page) => page.worktreeId)
  ])
  const replacedWorktreeIds = new Set([...targetScope.worktreeIds, ...remoteWorktreeIds])
  const remoteTerminalTabIds = new Set(
    [
      ...(remote.activeTabId ? [remote.activeTabId] : []),
      ...Object.values(remote.tabsByWorktree ?? {})
        .flat()
        .map((tab) => tab.id),
      ...Object.keys(remote.terminalLayoutsByTabId ?? {}),
      ...Object.keys(remote.remoteSessionIdsByTabId ?? {})
    ].filter((id): id is string => Boolean(id))
  )
  const replacedTerminalTabIds = new Set([
    ...remoteTerminalTabIds,
    ...Object.entries(current.tabsByWorktree ?? {})
      .filter(([worktreeId]) => replacedWorktreeIds.has(worktreeId))
      .flatMap(([, tabs]) => tabs.map((tab) => tab.id))
  ])
  const remoteBrowserWorkspaceIds = new Set(
    [
      ...Object.values(remote.browserTabsByWorktree ?? {})
        .flat()
        .map((tab) => tab.id),
      ...Object.keys(remote.browserPagesByWorkspace ?? {}),
      ...Object.values(remote.activeBrowserTabIdByWorktree ?? {}).filter(
        (id): id is string => id !== null
      )
    ].filter((id): id is string => Boolean(id))
  )
  const replacedBrowserWorkspaceIds = new Set([
    ...remoteBrowserWorkspaceIds,
    ...Object.entries(current.browserTabsByWorktree ?? {})
      .filter(([worktreeId]) => replacedWorktreeIds.has(worktreeId))
      .flatMap(([, tabs]) => tabs.map((tab) => tab.id))
  ])
  // Why: an empty relay slice is an authoritative "all target tabs closed"
  // snapshot. Replace the whole known target scope, not just remote keys.
  const omitRemoteWorktrees = <T>(record: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(
      Object.entries(record ?? {}).filter(([worktreeId]) => !replacedWorktreeIds.has(worktreeId))
    )
  const currentActiveRepoId =
    current.activeRepoId && targetScope.repoIds.has(current.activeRepoId)
      ? null
      : current.activeRepoId
  const currentActiveWorktreeId =
    current.activeWorktreeId && replacedWorktreeIds.has(current.activeWorktreeId)
      ? null
      : current.activeWorktreeId
  const currentActiveTabId =
    current.activeTabId && replacedTerminalTabIds.has(current.activeTabId)
      ? null
      : current.activeTabId

  return {
    ...current,
    activeRepoId: remote.activeRepoId ?? currentActiveRepoId,
    activeWorktreeId: remote.activeWorktreeId ?? currentActiveWorktreeId,
    activeTabId: remote.activeTabId ?? currentActiveTabId,
    tabsByWorktree: {
      ...omitRemoteWorktrees(current.tabsByWorktree),
      ...remote.tabsByWorktree
    },
    terminalLayoutsByTabId: {
      ...Object.fromEntries(
        Object.entries(current.terminalLayoutsByTabId ?? {}).filter(
          ([tabId]) => !replacedTerminalTabIds.has(tabId)
        )
      ),
      ...remote.terminalLayoutsByTabId
    },
    activeWorktreeIdsOnShutdown: [
      ...(current.activeWorktreeIdsOnShutdown ?? []).filter((id) => !replacedWorktreeIds.has(id)),
      ...(remote.activeWorktreeIdsOnShutdown ?? [])
    ],
    openFilesByWorktree: {
      ...omitRemoteWorktrees(current.openFilesByWorktree),
      ...remote.openFilesByWorktree
    },
    activeFileIdByWorktree: {
      ...omitRemoteWorktrees(current.activeFileIdByWorktree),
      ...remote.activeFileIdByWorktree
    },
    browserTabsByWorktree: {
      ...omitRemoteWorktrees(current.browserTabsByWorktree),
      ...remote.browserTabsByWorktree
    },
    browserPagesByWorkspace: {
      ...Object.fromEntries(
        Object.entries(current.browserPagesByWorkspace ?? {}).filter(
          ([workspaceId]) => !replacedBrowserWorkspaceIds.has(workspaceId)
        )
      ),
      ...remote.browserPagesByWorkspace
    },
    activeBrowserTabIdByWorktree: {
      ...omitRemoteWorktrees(current.activeBrowserTabIdByWorktree),
      ...remote.activeBrowserTabIdByWorktree
    },
    activeTabTypeByWorktree: {
      ...omitRemoteWorktrees(current.activeTabTypeByWorktree),
      ...remote.activeTabTypeByWorktree
    },
    activeTabIdByWorktree: {
      ...omitRemoteWorktrees(current.activeTabIdByWorktree),
      ...remote.activeTabIdByWorktree
    },
    unifiedTabs: {
      ...omitRemoteWorktrees(current.unifiedTabs),
      ...remote.unifiedTabs
    },
    tabGroups: {
      ...omitRemoteWorktrees(current.tabGroups),
      ...remote.tabGroups
    },
    tabGroupLayouts: {
      ...omitRemoteWorktrees(current.tabGroupLayouts),
      ...remote.tabGroupLayouts
    },
    activeGroupIdByWorktree: {
      ...omitRemoteWorktrees(current.activeGroupIdByWorktree),
      ...remote.activeGroupIdByWorktree
    },
    activeConnectionIdsAtShutdown: Array.from(
      new Set([
        ...(current.activeConnectionIdsAtShutdown ?? []),
        ...(remote.activeConnectionIdsAtShutdown ?? [])
      ])
    ),
    remoteSessionIdsByTabId: {
      ...Object.fromEntries(
        Object.entries(current.remoteSessionIdsByTabId ?? {}).filter(
          ([tabId]) => !replacedTerminalTabIds.has(tabId)
        )
      ),
      ...remote.remoteSessionIdsByTabId
    },
    lastVisitedAtByWorktreeId: {
      ...omitRemoteWorktrees(current.lastVisitedAtByWorktreeId),
      ...remote.lastVisitedAtByWorktreeId
    }
  }
}

async function hydrateRemoteWorkspaceSnapshot(
  targetId: string,
  snapshot: RemoteWorkspaceSnapshot
): Promise<void> {
  await runDuringRemoteWorkspaceHydration(async () => {
    const store = useAppStore.getState()
    const targetRepoIds = new Set(
      store.repos.filter((repo) => repo.connectionId === targetId).map((repo) => repo.id)
    )
    const targetWorktreeIds = new Set(
      Object.values(store.worktreesByRepo)
        .flat()
        .filter((worktree) => targetRepoIds.has(worktree.repoId))
        .map((worktree) => worktree.id)
    )
    const translated = translateRemoteWorkspaceSessionIds(targetId, snapshot.session)
    const merged = mergeRemoteWorkspaceSession(buildWorkspaceSessionPayload(store), translated, {
      repoIds: targetRepoIds,
      worktreeIds: targetWorktreeIds
    })
    store.hydrateWorkspaceSession(merged)
    store.hydrateTabsSession(merged)
    store.hydrateEditorSession(merged)
    store.hydrateBrowserSession(merged)
    await useAppStore.getState().reconnectPersistedTerminals()
  })
}

async function fetchAndHydrateRemoteWorkspace(targetId: string): Promise<void> {
  const snapshot = await window.api.remoteWorkspace?.get({ targetId })
  if (snapshot) {
    await hydrateRemoteWorkspaceSnapshot(targetId, snapshot)
  }
}

export function useIpcEvents(): void {
  useEffect(() => {
    const unsubs: (() => void)[] = []

    unsubs.push(
      window.api.repos.onChanged(() => {
        useAppStore.getState().fetchRepos()
      })
    )

    unsubs.push(
      window.api.worktrees.onChanged(async (data: { repoId: string }) => {
        // Why: diff before vs. after fetchWorktrees to detect server-side
        // deletions (CLI `orca worktree rm`, other window, out-of-band RPC)
        // and purge worktree-scoped state for removed ids. Without this,
        // `ptyIdsByTabId` would retain entries for tabs whose worktree is
        // gone, and SessionsStatusSegment's `boundPtyIds` set would keep
        // misclassifying the zombie as bound (design §2c, §4.4).
        const state = useAppStore.getState()
        const before = new Set((state.worktreesByRepo[data.repoId] ?? []).map((w) => w.id))
        await state.fetchWorktrees(data.repoId)
        const afterState = useAppStore.getState()
        const after = new Set((afterState.worktreesByRepo[data.repoId] ?? []).map((w) => w.id))
        const removed: string[] = []
        for (const id of before) {
          if (!after.has(id)) {
            removed.push(id)
          }
        }
        if (removed.length > 0) {
          console.warn(
            `[worktree-purge] diff-based purge removing state for ${removed.length} worktree(s):`,
            removed
          )
          afterState.purgeWorktreeTerminalState(removed)
        }
      })
    )

    unsubs.push(
      window.api.worktrees.onBaseStatus((event) => {
        useAppStore.getState().updateWorktreeBaseStatus(event)
      })
    )

    unsubs.push(
      window.api.worktrees.onRemoteBranchConflict((event) => {
        useAppStore.getState().updateWorktreeRemoteBranchConflict(event)
      })
    )

    unsubs.push(
      window.api.ui.onOpenSettings(() => {
        useAppStore.getState().openSettingsPage()
      })
    )

    // Why: the View > Appearance menu toggles settings directly in main (so
    // checkbox state reflects the persisted value without a round-trip) and
    // broadcasts the change. Merge it into the store so the sidebar and
    // titlebar re-render immediately instead of waiting for the next
    // fetchSettings() call.
    unsubs.push(
      window.api.settings.onChanged((updates) => {
        const store = useAppStore.getState()
        if (!store.settings) {
          return
        }
        useAppStore.setState({
          settings: {
            ...store.settings,
            ...updates,
            notifications: {
              ...store.settings.notifications,
              ...updates.notifications
            }
          }
        })
      })
    )

    unsubs.push(
      window.api.ui.onToggleLeftSidebar(() => {
        useAppStore.getState().toggleSidebar()
      })
    )

    unsubs.push(
      window.api.ui.onToggleRightSidebar(() => {
        useAppStore.getState().toggleRightSidebar()
      })
    )

    unsubs.push(
      window.api.ui.onToggleWorktreePalette(() => {
        const store = useAppStore.getState()
        if (store.activeModal === 'worktree-palette') {
          store.closeModal()
          return
        }
        store.openModal('worktree-palette')
      })
    )

    unsubs.push(
      window.api.ui.onOpenQuickOpen(() => {
        const store = useAppStore.getState()
        if (store.activeView === 'terminal' && store.activeWorktreeId !== null) {
          store.openModal('quick-open')
        }
      })
    )

    unsubs.push(
      window.api.ui.onOpenNewWorkspace(() => {
        // Why: mirror the renderer's App.tsx Cmd+N guard — only open the
        // composer when there is at least one real git repo configured, so
        // users on a fresh install don't get a modal with nothing to target.
        const store = useAppStore.getState()
        if (!store.repos.some((repo) => isGitRepoKind(repo))) {
          return
        }
        if (store.activeModal === 'new-workspace-composer') {
          return
        }
        store.openModal('new-workspace-composer', { telemetrySource: 'shortcut' })
      })
    )

    unsubs.push(
      window.api.ui.onJumpToWorktreeIndex((index) => {
        const store = useAppStore.getState()
        if (store.activeView !== 'terminal') {
          return
        }
        const visibleIds = getVisibleWorktreeIds()
        if (index < visibleIds.length) {
          activateAndRevealWorktree(visibleIds[index])
        }
      })
    )

    unsubs.push(
      window.api.ui.onWorktreeHistoryNavigate((direction) => {
        const store = useAppStore.getState()
        // Why: mirror the button-visibility rule — worktree history navigation
        // is only meaningful in the terminal (worktree) view. Settings/Tasks
        // transitions aren't worktree activations and the buttons are hidden,
        // so the shortcut no-ops there too.
        if (store.activeView !== 'terminal') {
          return
        }
        if (direction === 'back') {
          store.goBackWorktree()
        } else {
          store.goForwardWorktree()
        }
      })
    )

    unsubs.push(
      window.api.ui.onToggleStatusBar(() => {
        const store = useAppStore.getState()
        store.setStatusBarVisible(!store.statusBarVisible)
      })
    )

    unsubs.push(
      window.api.ui.onActivateWorktree(({ repoId, worktreeId, setup, startup }) => {
        void (async () => {
          // Why: fetch worktrees first so the activation helper can resolve
          // the CLI-created worktree via findWorktreeById — it arrived from
          // the main process and is not yet in the renderer state.
          await useAppStore.getState().fetchWorktrees(repoId)
          // Why: route through activateAndRevealWorktree so CLI-created
          // worktrees share the canonical activation path with UI-created
          // ones. This records the visit in the back/forward history stack
          // (recordWorktreeVisit), without which the nav buttons would
          // ignore the CLI-driven workspace switch.
          activateAndRevealWorktree(worktreeId, { setup, startup })
        })().catch((error) => {
          console.error('Failed to activate CLI-created worktree:', error)
        })
      })
    )

    unsubs.push(
      window.api.ui.onCreateTerminal(({ worktreeId, command, title }) => {
        const store = useAppStore.getState()
        store.setActiveView('terminal')
        store.setActiveWorktree(worktreeId)
        // Why: CLI-driven terminal creation is a user-initiated worktree switch
        // and must stamp focus recency for Cmd+J. Doesn't route through
        // activateAndRevealWorktree because it has custom terminal-creation
        // logic; see docs/cmd-j-empty-query-ordering.md.
        store.markWorktreeVisited(worktreeId)
        const tab = store.createTab(worktreeId)
        store.setActiveTabType('terminal')
        store.setActiveTab(tab.id)
        store.revealWorktreeInSidebar(worktreeId)
        if (title) {
          store.setTabCustomTitle(tab.id, title)
        }
        if (command) {
          store.queueTabStartupCommand(tab.id, { command })
        }
      })
    )

    // Why: CLI-driven terminal creation sends a request and waits for the
    // tabId reply so it can resolve a handle the caller can use immediately.
    // This mirrors the browser's onRequestTabCreate/replyTabCreate pattern.
    unsubs.push(
      window.api.ui.onRequestTerminalCreate((data) => {
        try {
          const store = useAppStore.getState()
          const worktreeId = data.worktreeId ?? store.activeWorktreeId
          if (!worktreeId) {
            window.api.ui.replyTerminalCreate({
              requestId: data.requestId,
              error: 'No active worktree'
            })
            return
          }
          store.setActiveView('terminal')
          store.setActiveWorktree(worktreeId)
          // Why: CLI-driven terminal-create request is user-initiated; stamp
          // focus recency for Cmd+J. See docs/cmd-j-empty-query-ordering.md.
          store.markWorktreeVisited(worktreeId)
          const tab = store.createTab(worktreeId)
          store.setActiveTabType('terminal')
          store.setActiveTab(tab.id)
          store.revealWorktreeInSidebar(worktreeId)
          if (data.title) {
            store.setTabCustomTitle(tab.id, data.title)
          }
          if (data.command) {
            store.queueTabStartupCommand(tab.id, { command: data.command })
          }
          window.api.ui.replyTerminalCreate({
            requestId: data.requestId,
            tabId: tab.id,
            title: data.title ?? tab.title
          })
        } catch (err) {
          window.api.ui.replyTerminalCreate({
            requestId: data.requestId,
            error: err instanceof Error ? err.message : 'Terminal creation failed'
          })
        }
      })
    )

    unsubs.push(
      window.api.ui.onSplitTerminal(({ tabId, paneRuntimeId, direction, command }) => {
        const detail: SplitTerminalPaneDetail = { tabId, paneRuntimeId, direction, command }
        window.dispatchEvent(new CustomEvent(SPLIT_TERMINAL_PANE_EVENT, { detail }))
      })
    )

    unsubs.push(
      window.api.ui.onRenameTerminal(({ tabId, title }) => {
        useAppStore.getState().setTabCustomTitle(tabId, title)
      })
    )

    unsubs.push(
      window.api.ui.onFocusTerminal(({ tabId, worktreeId }) => {
        const store = useAppStore.getState()
        store.setActiveWorktree(worktreeId)
        // Why: CLI-driven focus is a user-initiated switch; stamp focus
        // recency for Cmd+J. See docs/cmd-j-empty-query-ordering.md.
        store.markWorktreeVisited(worktreeId)
        store.setActiveView('terminal')
        store.setActiveTab(tabId)
        store.revealWorktreeInSidebar(worktreeId)
      })
    )

    unsubs.push(
      window.api.ui.onCloseTerminal(({ tabId, paneRuntimeId }) => {
        if (paneRuntimeId != null) {
          // Why: when targeting a specific pane in a split layout, dispatch to the
          // lifecycle hook so PaneManager.closePane() handles sibling promotion.
          // The lifecycle hook falls through to closeTab() if this is the last pane.
          const detail: CloseTerminalPaneDetail = { tabId, paneRuntimeId }
          window.dispatchEvent(new CustomEvent(CLOSE_TERMINAL_PANE_EVENT, { detail }))
        } else {
          useAppStore.getState().closeTab(tabId)
        }
      })
    )

    unsubs.push(
      window.api.ui.onSleepWorktree(({ worktreeId }) => {
        void runSleepWorktree(worktreeId)
      })
    )

    // Hydrate initial update status then subscribe to changes
    window.api.updater.getStatus().then((status) => {
      useAppStore.getState().setUpdateStatus(status as UpdateStatus)
    })

    unsubs.push(
      window.api.updater.onStatus((raw) => {
        const status = raw as UpdateStatus
        useAppStore.getState().setUpdateStatus(status)
      })
    )

    unsubs.push(
      window.api.updater.onClearDismissal(() => {
        useAppStore.getState().clearDismissedUpdateVersion()
      })
    )

    unsubs.push(
      window.api.ui.onFullscreenChanged((isFullScreen) => {
        useAppStore.getState().setIsFullScreen(isFullScreen)
      })
    )

    unsubs.push(
      window.api.browser.onGuestLoadFailed(({ browserPageId, loadError }) => {
        useAppStore.getState().updateBrowserPageState(browserPageId, {
          loading: false,
          loadError,
          canGoBack: false,
          canGoForward: false
        })
      })
    )

    // Why: agent-browser drives navigation via CDP, bypassing Electron's webview
    // event system. The renderer's did-navigate listener never fires for those
    // navigations, so the Zustand store (address bar, tab title) stays stale.
    // This IPC pushes the live URL/title from main after goto/click/back/reload.
    unsubs.push(
      window.api.browser.onNavigationUpdate(({ browserPageId, url, title }) => {
        const store = useAppStore.getState()
        store.setBrowserPageUrl(browserPageId, url)
        store.updateBrowserPageState(browserPageId, { title, loading: false })
      })
    )

    // Why: browser webviews only start their guest process when the container
    // has display != none. After app restart, activeTabType defaults to 'terminal'
    // so persisted browser tabs never mount. The main process sends this IPC
    // before browser commands so the webview can start and registerGuest fires.
    unsubs.push(
      window.api.browser.onActivateView(() => {
        useAppStore.getState().setActiveTabType('browser')
      })
    )

    // Why: `orca tab switch --focus` lands here after the bridge's state-only
    // `tabSwitch`. We deliberately DO NOT call `setActiveWorktree` — multiple
    // agents drive browsers in parallel worktrees, so a global focus call from
    // one agent's tab switch would steal the user's view from whichever
    // worktree they're actually reading. Instead `focusBrowserTabInWorktree`
    // updates the targeted worktree's per-worktree state in place; globals
    // (activeBrowserTabId, activeTabType) only flip when the user is already
    // on the targeted worktree. Cross-worktree --focus calls are silent
    // pre-staging for whenever the user next visits that worktree.
    unsubs.push(
      window.api.browser.onPaneFocus(({ worktreeId, browserPageId }) => {
        const store = useAppStore.getState()
        // Why: main sends `worktreeId: null` if the tab closed between the
        // bridge resolving tabSwitch and getWorktreeIdForTab running. Falling
        // back to activeWorktreeId means a stale page id in another worktree
        // is silently ignored by focusBrowserTabInWorktree (page not found
        // in its tabsForWorktree.find), which is the intended no-op.
        const targetWt = worktreeId ?? store.activeWorktreeId
        if (!targetWt) {
          return
        }
        store.focusBrowserTabInWorktree(targetWt, browserPageId)
      })
    )

    unsubs.push(
      window.api.browser.onOpenLinkInOrcaTab(({ browserPageId, url }) => {
        const store = useAppStore.getState()
        const sourcePage = Object.values(store.browserPagesByWorkspace)
          .flat()
          .find((page) => page.id === browserPageId)
        if (!sourcePage) {
          return
        }
        // Why: the guest process can request "open this link in Orca", but it
        // does not own Orca's worktree/tab model. Resolve the source page's
        // worktree and create a new outer browser tab so the link opens as a
        // separate tab in the outer Orca tab bar.
        store.createBrowserTab(sourcePage.worktreeId, url, { title: url })
      })
    )

    // Shortcut forwarding for embedded browser guests whose webContents
    // capture keyboard focus and bypass the renderer's window-level keydown.
    unsubs.push(
      window.api.ui.onNewBrowserTab(() => {
        const store = useAppStore.getState()
        const worktreeId = store.activeWorktreeId
        if (worktreeId) {
          store.createBrowserTab(worktreeId, store.browserDefaultUrl ?? 'about:blank', {
            title: 'New Browser Tab',
            focusAddressBar: true
          })
        }
      })
    )

    // Why: CLI-driven tab creation sends a request with a specific worktreeId and
    // url. The renderer creates the tab and replies with the workspace ID so the
    // main process can wait for registerGuest before returning to the CLI.
    unsubs.push(
      window.api.ui.onRequestTabCreate((data) => {
        try {
          const store = useAppStore.getState()
          const worktreeId = data.worktreeId ?? store.activeWorktreeId
          if (!worktreeId) {
            window.api.ui.replyTabCreate({ requestId: data.requestId, error: 'No active worktree' })
            return
          }
          // Why: CLI-created tabs should land in the same group as the active
          // browser tab, not the terminal's group (which is typically the
          // UI-active group when an agent is running commands).
          const activeBrowserTabId = store.activeBrowserTabIdByWorktree[worktreeId]
          const activeBrowserUnifiedTab = activeBrowserTabId
            ? (store.unifiedTabsByWorktree[worktreeId] ?? []).find(
                (t) => t.contentType === 'browser' && t.entityId === activeBrowserTabId
              )
            : undefined

          const workspace = store.createBrowserTab(worktreeId, data.url, {
            title: data.url,
            targetGroupId: activeBrowserUnifiedTab?.groupId,
            sessionProfileId: data.sessionProfileId
          })
          // Why: registerGuest fires with the page ID (not workspace ID) as
          // browserPageId. Return the page ID so waitForTabRegistration can
          // correlate correctly.
          const pages = useAppStore.getState().browserPagesByWorkspace[workspace.id] ?? []
          const browserPageId = pages[0]?.id ?? workspace.id
          window.api.ui.replyTabCreate({ requestId: data.requestId, browserPageId })
        } catch (err) {
          window.api.ui.replyTabCreate({
            requestId: data.requestId,
            error: err instanceof Error ? err.message : 'Tab creation failed'
          })
        }
      })
    )

    unsubs.push(
      window.api.ui.onRequestTabSetProfile((data) => {
        try {
          const store = useAppStore.getState()
          const owningWorkspace = Object.values(store.browserTabsByWorktree)
            .flat()
            .find((workspace) => {
              if (workspace.id === data.browserPageId) {
                return true
              }
              const pages = store.browserPagesByWorkspace[workspace.id] ?? []
              return pages.some((page) => page.id === data.browserPageId)
            })
          if (!owningWorkspace) {
            window.api.ui.replyTabSetProfile({
              requestId: data.requestId,
              error: `Browser tab ${data.browserPageId} not found`
            })
            return
          }
          // Why: a workspace can host multiple browser pages; profile switch must
          // tear down every sibling webview, not just the one referenced by the IPC.
          const workspacePages = store.browserPagesByWorkspace[owningWorkspace.id] ?? []
          if (workspacePages.length > 0) {
            for (const page of workspacePages) {
              destroyPersistentWebview(page.id)
            }
          } else {
            destroyPersistentWebview(data.browserPageId)
          }
          store.switchBrowserTabProfile(owningWorkspace.id, data.profileId)
          window.api.ui.replyTabSetProfile({ requestId: data.requestId })
        } catch (err) {
          window.api.ui.replyTabSetProfile({
            requestId: data.requestId,
            error: err instanceof Error ? err.message : 'Tab profile update failed'
          })
        }
      })
    )

    unsubs.push(
      window.api.ui.onRequestTabClose((data) => {
        try {
          const store = useAppStore.getState()
          const explicitTargetId = data.tabId ?? null
          let tabToClose =
            explicitTargetId ??
            (data.worktreeId
              ? (store.activeBrowserTabIdByWorktree?.[data.worktreeId] ?? null)
              : store.activeBrowserTabId)
          if (!tabToClose) {
            window.api.ui.replyTabClose({
              requestId: data.requestId,
              error: 'No active browser tab to close'
            })
            return
          }
          // Why: the bridge stores tabs keyed by browserPageId (which is the page
          // ID from registerGuest), but closeBrowserTab expects a workspace ID. If
          // tabToClose is a page ID, close only that page unless it is the
          // last page in its workspace. The CLI's `tab close --page` contract
          // targets one browser page, not the entire workspace tab.
          const isWorkspaceId = Object.values(store.browserTabsByWorktree)
            .flat()
            .some((ws) => ws.id === tabToClose)
          if (!isWorkspaceId) {
            const owningWorkspace = Object.entries(store.browserPagesByWorkspace).find(
              ([, pages]) => pages.some((p) => p.id === tabToClose)
            )
            if (owningWorkspace) {
              const [workspaceId, pages] = owningWorkspace
              if (pages.length <= 1) {
                store.closeBrowserTab(workspaceId)
              } else {
                store.closeBrowserPage(tabToClose)
              }
              window.api.ui.replyTabClose({ requestId: data.requestId })
              return
            }
          }
          if (explicitTargetId) {
            window.api.ui.replyTabClose({
              requestId: data.requestId,
              error: `Browser tab ${explicitTargetId} not found`
            })
            return
          }
          store.closeBrowserTab(tabToClose)
          window.api.ui.replyTabClose({ requestId: data.requestId })
        } catch (err) {
          window.api.ui.replyTabClose({
            requestId: data.requestId,
            error: err instanceof Error ? err.message : 'Tab close failed'
          })
        }
      })
    )

    unsubs.push(
      window.api.ui.onNewTerminalTab(() => {
        const store = useAppStore.getState()
        const worktreeId = store.activeWorktreeId
        if (!worktreeId) {
          return
        }
        const newTab = store.createTab(worktreeId)
        store.setActiveTabType('terminal')
        // Why: replicate the full reconciliation from Terminal.tsx handleNewTab
        // so the new tab appends at the visual end instead of jumping to index 0
        // when tabBarOrderByWorktree is unset (e.g. restored worktrees).
        const currentTerminals = store.tabsByWorktree[worktreeId] ?? []
        const currentEditors = store.openFiles.filter((f) => f.worktreeId === worktreeId)
        const currentBrowsers = store.browserTabsByWorktree[worktreeId] ?? []
        const stored = store.tabBarOrderByWorktree[worktreeId]
        const termIds = currentTerminals.map((t) => t.id)
        const editorIds = currentEditors.map((f) => f.id)
        const browserIds = currentBrowsers.map((tab) => tab.id)
        const validIds = new Set([...termIds, ...editorIds, ...browserIds])
        const base = (stored ?? []).filter((id) => validIds.has(id))
        const inBase = new Set(base)
        for (const id of [...termIds, ...editorIds, ...browserIds]) {
          if (!inBase.has(id)) {
            base.push(id)
            inBase.add(id)
          }
        }
        const order = base.filter((id) => id !== newTab.id)
        order.push(newTab.id)
        store.setTabBarOrder(worktreeId, order)
        focusTerminalTabSurface(newTab.id)
      })
    )

    unsubs.push(
      window.api.ui.onCloseActiveTab(() => {
        const store = useAppStore.getState()
        if (store.activeTabType === 'browser' && store.activeBrowserTabId) {
          store.closeBrowserTab(store.activeBrowserTabId)
        }
      })
    )

    unsubs.push(window.api.ui.onSwitchTab(handleSwitchTab))
    unsubs.push(window.api.ui.onSwitchTabAcrossAllTypes(handleSwitchTabAcrossAllTypes))
    unsubs.push(window.api.ui.onSwitchTerminalTab(handleSwitchTerminalTab))

    // Hydrate initial rate limit state then subscribe to push updates
    window.api.rateLimits.get().then((state) => {
      useAppStore.getState().setRateLimitsFromPush(state as RateLimitState)
    })

    unsubs.push(
      window.api.rateLimits.onUpdate((state) => {
        useAppStore.getState().setRateLimitsFromPush(state as RateLimitState)
      })
    )

    // Track SSH connection state changes so the renderer can show
    // disconnected indicators on remote worktrees.
    // Why: hydrate initial state for all known targets so worktree cards
    // reflect the correct connected/disconnected state on app launch.
    void (async () => {
      try {
        const targets = await window.api.ssh.listTargets()
        // Why: populate target labels map so WorktreeCard (and other components)
        // can look up display labels without issuing per-card IPC calls.
        const labels = new Map<string, string>()
        for (const target of targets) {
          labels.set(target.id, target.label)
          const state = await window.api.ssh.getState({ targetId: target.id })
          if (state) {
            useAppStore.getState().setSshConnectionState(target.id, state as SshConnectionState)
            // Why: if the renderer reattaches while an SSH session is alive
            // (e.g. window re-creation or reload), forwarded and detected ports
            // are only populated via push events. Fetch current snapshots so the
            // Ports panel doesn't show empty for an active session.
            if ((state as SshConnectionState).status === 'connected') {
              const [forwards, detected] = await Promise.all([
                window.api.ssh.listPortForwards({ targetId: target.id }),
                window.api.ssh.listDetectedPorts({ targetId: target.id })
              ])
              // Why: if the session disconnected while we were awaiting the
              // snapshot, the disconnect handler already cleared port state.
              // Applying stale data here would resurrect a dead session's ports.
              const currentState = useAppStore.getState().sshConnectionStates.get(target.id)
              if (currentState?.status === 'connected') {
                useAppStore.getState().setPortForwards(target.id, forwards)
                useAppStore.getState().setDetectedPorts(target.id, detected)
              }
              if (target.remoteWorkspaceSyncEnabled) {
                const repos = useAppStore
                  .getState()
                  .repos.filter((repo) => repo.connectionId === target.id)
                await Promise.all(
                  repos.map((repo) => useAppStore.getState().fetchWorktrees(repo.id))
                )
                void fetchAndHydrateRemoteWorkspace(target.id)
              }
            }
          }
        }
        useAppStore.getState().setSshTargetLabels(labels)
      } catch {
        // SSH may not be configured
      }
    })()

    unsubs.push(
      window.api.ssh.onCredentialRequest((data) => {
        useAppStore.getState().enqueueSshCredentialRequest(data)
      })
    )

    unsubs.push(
      window.api.ssh.onCredentialResolved(({ requestId }) => {
        useAppStore.getState().removeSshCredentialRequest(requestId)
      })
    )

    unsubs.push(
      window.api.ssh.onPortForwardsChanged(({ targetId, forwards }) => {
        useAppStore.getState().setPortForwards(targetId, forwards)
      })
    )

    unsubs.push(
      window.api.ssh.onDetectedPortsChanged(({ targetId, ports }) => {
        useAppStore.getState().setDetectedPorts(targetId, ports)
      })
    )

    unsubs.push(
      window.api.ssh.onStateChanged((data: { targetId: string; state: unknown }) => {
        const store = useAppStore.getState()
        const state = data.state as SshConnectionState
        store.setSshConnectionState(data.targetId, state)
        const remoteRepos = store.repos.filter((r) => r.connectionId === data.targetId)

        // Why: targets added after boot aren't in the labels map. Re-fetch
        // so the status bar popover shows the new target immediately.
        if (!store.sshTargetLabels.has(data.targetId)) {
          window.api.ssh
            .listTargets()
            .then((targets) => {
              const labels = new Map<string, string>()
              for (const t of targets as { id: string; label: string }[]) {
                labels.set(t.id, t.label)
              }
              useAppStore.getState().setSshTargetLabels(labels)
            })
            .catch(() => {})
        }

        if (
          ['disconnected', 'auth-failed', 'reconnection-failed', 'error'].includes(state.status)
        ) {
          // Why: the remote agent list is tied to a live SSH connection. On
          // disconnect the relay is gone, so clear the cached list and dedup
          // promise. When the user reconnects and opens the quick-launch menu,
          // ensureRemoteDetectedAgents will re-detect against the new relay.
          store.clearRemoteDetectedAgents(data.targetId)

          // Why: defensive — clear port forward and detected port state in case
          // the broadcast from removeAllForwards races with the state change.
          store.clearPortForwards(data.targetId)
          store.setDetectedPorts(data.targetId, [])

          // Why: an explicit disconnect or terminal failure tears down the SSH
          // PTY provider without emitting per-PTY exit events. Clear the stale
          // PTY ids in renderer state so a later reconnect remounts TerminalPane
          // instead of keeping a dead remote PTY attached to the tab.
          const remoteWorktreeIds = new Set(
            Object.values(store.worktreesByRepo)
              .flat()
              .filter((w) => remoteRepos.some((r) => r.id === w.repoId))
              .map((w) => w.id)
          )
          for (const worktreeId of remoteWorktreeIds) {
            const tabs = useAppStore.getState().tabsByWorktree[worktreeId] ?? []
            for (const tab of tabs) {
              if (tab.ptyId) {
                useAppStore.getState().clearTabPtyId(tab.id)
              }
            }
          }
        }

        if (state.status === 'connected') {
          // Why: the file explorer may have tried (and failed) to load the tree
          // before the SSH connection was established. Bumping the generation
          // lets it detect that providers are now available and retry.
          store.bumpSshConnectedGeneration()
          void Promise.all(remoteRepos.map((r) => store.fetchWorktrees(r.id))).then(() => {
            // Why: terminal panes that failed to spawn (no PTY provider on cold
            // start) sit inert. Bumping generation forces TerminalPane to remount
            // and retry pty:spawn. Only bump tabs with no live ptyId.
            const freshStore = useAppStore.getState()
            const remoteRepoIds = new Set(remoteRepos.map((r) => r.id))
            const worktreeIds = Object.values(freshStore.worktreesByRepo)
              .flat()
              .filter((w) => remoteRepoIds.has(w.repoId))
              .map((w) => w.id)

            for (const worktreeId of worktreeIds) {
              const tabs = freshStore.tabsByWorktree[worktreeId] ?? []
              const hasDead = tabs.some((t) => !t.ptyId)
              if (hasDead) {
                useAppStore.setState((s) => ({
                  tabsByWorktree: {
                    ...s.tabsByWorktree,
                    [worktreeId]: (s.tabsByWorktree[worktreeId] ?? []).map((t) =>
                      t.ptyId ? t : { ...t, generation: (t.generation ?? 0) + 1 }
                    )
                  }
                }))
              }
            }
            void window.api.ssh
              .listTargets()
              .then((targets) => {
                const target = targets.find((entry) => entry.id === data.targetId)
                if (target?.remoteWorkspaceSyncEnabled) {
                  void fetchAndHydrateRemoteWorkspace(data.targetId)
                }
              })
              .catch(() => {})
          })
        }
      })
    )

    let remoteWorkspaceClientId: string | null = null
    void window.api.remoteWorkspace?.clientId().then((id) => {
      remoteWorkspaceClientId = id
    })
    const unsubscribeRemoteWorkspace = window.api.remoteWorkspace?.onChanged((event) => {
      if (event.sourceClientId && event.sourceClientId === remoteWorkspaceClientId) {
        return
      }
      void hydrateRemoteWorkspaceSnapshot(event.targetId, event.snapshot)
    })
    if (unsubscribeRemoteWorkspace) {
      unsubs.push(unsubscribeRemoteWorkspace)
    }

    // Zoom handling for menu accelerators and keyboard fallback paths.
    unsubs.push(
      window.api.ui.onTerminalZoom((direction) => {
        const { activeView, activeTabType, editorFontZoomLevel, setEditorFontZoomLevel, settings } =
          useAppStore.getState()
        const target = resolveZoomTarget({
          activeView,
          activeTabType,
          activeElement: document.activeElement
        })
        if (target === 'terminal') {
          return
        }
        if (target === 'editor') {
          const next = nextEditorFontZoomLevel(editorFontZoomLevel, direction)
          setEditorFontZoomLevel(next)
          void window.api.ui.set({ editorFontZoomLevel: next })

          // Why: use the same base font size the editor surfaces use (terminalFontSize)
          // and computeEditorFontSize to account for clamping, so the overlay percent
          // matches the actual rendered size.
          const baseFontSize = settings?.terminalFontSize ?? 13
          const actual = computeEditorFontSize(baseFontSize, next)
          const percent = Math.round((actual / baseFontSize) * 100)
          dispatchZoomLevelChanged('editor', percent)
          return
        }

        const current = window.api.ui.getZoomLevel()
        const rawNext =
          direction === 'in' ? current + ZOOM_STEP : direction === 'out' ? current - ZOOM_STEP : 0
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, rawNext))

        applyUIZoom(next)
        void window.api.ui.set({ uiZoomLevel: next })

        dispatchZoomLevelChanged('ui', zoomLevelToPercent(next))
      })
    )

    // Why: agent status arrives from native hook receivers in the main process.
    // Re-parse it here so the renderer enforces the same normalization rules
    // (state enum, field truncation) regardless of whether the source was a
    // hook callback or an OSC fallback path.
    unsubs.push(
      window.api.agentStatus.onSet((data) => {
        const store = useAppStore.getState()
        // Why: the IPC payload is already a structured object — pass it
        // straight to the object-input normalizer instead of round-tripping
        // through JSON.stringify/JSON.parse. Hook events can fire many times
        // per second during a tool-use run, so this avoids the per-event
        // serialization cost.
        const payload = normalizeAgentStatusPayload({
          state: data.state,
          prompt: data.prompt,
          agentType: data.agentType,
          toolName: data.toolName,
          toolInput: data.toolInput,
          lastAssistantMessage: data.lastAssistantMessage,
          interrupted: data.interrupted
        })
        if (!payload) {
          return
        }
        // Why: resolve tab existence and terminal title in a single pass.
        // Previously the code walked store.tabsByWorktree twice — once to
        // look up the tab-level title (when the pane-level title was
        // missing) and again for the explicit tabExists check. A paneKey
        // that no longer resolves to a live tab belongs to a pane that has
        // already been torn down; dropping here prevents orphan entries
        // from accumulating in agentStatusByPaneKey.
        const { exists, title } = resolvePaneKey(store, data.paneKey)
        if (!exists) {
          return
        }
        store.setAgentStatus(data.paneKey, payload, title)
      })
    )

    // Why: hydrate mobile-fit overrides before terminal panes run their first
    // attach/fit logic, so a renderer reload doesn't undo active mobile fits.
    void window.api.runtime.getTerminalFitOverrides().then((overrides) => {
      hydrateOverrides(overrides)
    })

    unsubs.push(
      window.api.runtime.onTerminalFitOverrideChanged((event) => {
        setFitOverride(event.ptyId, event.mode, event.cols, event.rows)
      })
    )

    unsubs.push(
      // Why: presence-lock driver state mirror. Updates the renderer's
      // mobile-driver-state map so TerminalPane / pty-connection guards
      // know which PTYs are currently driven by mobile. See
      // docs/mobile-presence-lock.md.
      window.api.runtime.onTerminalDriverChanged((event) => {
        setDriverForPty(event.ptyId, event.driver)
      })
    )

    return () => unsubs.forEach((fn) => fn())
  }, [])
}

/** Resolve a paneKey (tabId:paneId) to both a liveness check and the current
 *  terminal title, in a single walk of tabsByWorktree. Used for agent type
 *  inference when the CLI payload omits agentType, plus to drop status updates
 *  targeted at panes whose tabs have already been torn down.
 *  Why combined: callers need both pieces per hook event, and hook events can
 *  fire many times per second during a tool-use run. Two separate O(N) scans
 *  over the same map is wasteful; one pass returns both. */
function resolvePaneKey(
  store: ReturnType<typeof useAppStore.getState>,
  paneKey: string
): { exists: boolean; title: string | undefined } {
  const [tabId, paneIdRaw] = paneKey.split(':')
  if (!tabId) {
    return { exists: false, title: undefined }
  }
  // Why: split panes track per-pane titles in runtimePaneTitlesByTabId; prefer
  // the pane's own title over the tab-level (last-winning) title so agent type
  // inference attributes status to the correct pane.
  const paneTitles = store.runtimePaneTitlesByTabId?.[tabId]
  const paneIdNum = paneIdRaw !== undefined ? Number(paneIdRaw) : NaN
  const rawPaneTitle = paneTitles && !Number.isNaN(paneIdNum) ? paneTitles[paneIdNum] : undefined
  // Why: treat an empty-string paneTitle as "no title" so the tab-level
  // fallback still fires. `paneTitle ?? tabTitle` alone would short-circuit on
  // '' and also erase any previously-cached terminalTitle in the store
  // (`terminalTitle ?? existing?.terminalTitle` resolves to '').
  const paneTitle = rawPaneTitle && rawPaneTitle.length > 0 ? rawPaneTitle : undefined
  let exists = false
  let tabTitle: string | undefined
  for (const tabs of Object.values(store.tabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.id === tabId) {
        exists = true
        tabTitle = tab.title
        break
      }
    }
    if (exists) {
      break
    }
  }
  return { exists, title: paneTitle ?? tabTitle }
}
