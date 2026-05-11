import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/types'

function getWorktreePathFromId(worktreeId: string): string | null {
  const separatorIdx = worktreeId.indexOf('::')
  return separatorIdx >= 0 ? worktreeId.slice(separatorIdx + 2) : null
}

function worktreePathInScope(worktreeId: string, knownWorktreePaths: Set<string>): boolean {
  const worktreePath = getWorktreePathFromId(worktreeId)
  return worktreePath ? knownWorktreePaths.has(worktreePath) : false
}

function preserveRemoteRecordOutsideScope<T>(
  input: Record<string, T> | undefined,
  knownWorktreePaths: Set<string>
): Record<string, T> | undefined {
  if (!input) {
    return undefined
  }
  const entries = Object.entries(input).filter(
    ([worktreeId]) => !worktreePathInScope(worktreeId, knownWorktreePaths)
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function preserveRemoteSessionOutsideScope(
  remote: WorkspaceSessionState,
  knownWorktreePaths: Set<string>
): WorkspaceSessionState {
  const tabsByWorktree = preserveRemoteRecordOutsideScope(remote.tabsByWorktree, knownWorktreePaths)
  const browserTabsByWorktree = preserveRemoteRecordOutsideScope(
    remote.browserTabsByWorktree,
    knownWorktreePaths
  )
  const preservedTerminalTabIds = new Set(
    Object.values(tabsByWorktree ?? {})
      .flat()
      .map((tab) => tab.id)
  )
  const preservedBrowserWorkspaceIds = new Set(
    Object.values(browserTabsByWorktree ?? {})
      .flat()
      .map((tab) => tab.id)
  )
  const activeWorktreeId =
    remote.activeWorktreeId && !worktreePathInScope(remote.activeWorktreeId, knownWorktreePaths)
      ? remote.activeWorktreeId
      : null

  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: activeWorktreeId ? remote.activeRepoId : null,
    activeWorktreeId,
    activeTabId:
      remote.activeTabId && preservedTerminalTabIds.has(remote.activeTabId)
        ? remote.activeTabId
        : null,
    tabsByWorktree: tabsByWorktree ?? {},
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(remote.terminalLayoutsByTabId ?? {}).filter(([tabId]) =>
        preservedTerminalTabIds.has(tabId)
      )
    ),
    activeWorktreeIdsOnShutdown: remote.activeWorktreeIdsOnShutdown?.filter(
      (worktreeId) => !worktreePathInScope(worktreeId, knownWorktreePaths)
    ),
    openFilesByWorktree: preserveRemoteRecordOutsideScope(
      remote.openFilesByWorktree,
      knownWorktreePaths
    ),
    activeFileIdByWorktree: preserveRemoteRecordOutsideScope(
      remote.activeFileIdByWorktree,
      knownWorktreePaths
    ),
    browserTabsByWorktree,
    browserPagesByWorkspace: remote.browserPagesByWorkspace
      ? Object.fromEntries(
          Object.entries(remote.browserPagesByWorkspace).filter(([workspaceId]) =>
            preservedBrowserWorkspaceIds.has(workspaceId)
          )
        )
      : undefined,
    activeBrowserTabIdByWorktree: preserveRemoteRecordOutsideScope(
      remote.activeBrowserTabIdByWorktree,
      knownWorktreePaths
    ),
    activeTabTypeByWorktree: preserveRemoteRecordOutsideScope(
      remote.activeTabTypeByWorktree,
      knownWorktreePaths
    ),
    browserUrlHistory: remote.browserUrlHistory,
    activeTabIdByWorktree: preserveRemoteRecordOutsideScope(
      remote.activeTabIdByWorktree,
      knownWorktreePaths
    ),
    unifiedTabs: preserveRemoteRecordOutsideScope(remote.unifiedTabs, knownWorktreePaths),
    tabGroups: preserveRemoteRecordOutsideScope(remote.tabGroups, knownWorktreePaths),
    tabGroupLayouts: preserveRemoteRecordOutsideScope(remote.tabGroupLayouts, knownWorktreePaths),
    activeGroupIdByWorktree: preserveRemoteRecordOutsideScope(
      remote.activeGroupIdByWorktree,
      knownWorktreePaths
    ),
    activeConnectionIdsAtShutdown: remote.activeConnectionIdsAtShutdown,
    remoteSessionIdsByTabId: remote.remoteSessionIdsByTabId
      ? Object.fromEntries(
          Object.entries(remote.remoteSessionIdsByTabId).filter(([tabId]) =>
            preservedTerminalTabIds.has(tabId)
          )
        )
      : undefined,
    agentResumeBindingsByPaneKey: remote.agentResumeBindingsByPaneKey
      ? Object.fromEntries(
          Object.entries(remote.agentResumeBindingsByPaneKey).filter(([paneKey]) => {
            const tabId = paneKey.split(':')[0]
            return Boolean(tabId && preservedTerminalTabIds.has(tabId))
          })
        )
      : undefined,
    lastVisitedAtByWorktreeId: preserveRemoteRecordOutsideScope(
      remote.lastVisitedAtByWorktreeId,
      knownWorktreePaths
    )
  }
}

export function mergeLocalSessionWithRemoteOutsideScope(
  remote: WorkspaceSessionState,
  local: WorkspaceSessionState,
  knownWorktreePaths: Set<string>
): WorkspaceSessionState {
  // Why: a new device may import SSH projects one at a time. Its local slice
  // must not delete remote worktrees it has not discovered yet.
  const preserved = preserveRemoteSessionOutsideScope(remote, knownWorktreePaths)
  return {
    ...local,
    activeRepoId: local.activeRepoId ?? preserved.activeRepoId,
    activeWorktreeId: local.activeWorktreeId ?? preserved.activeWorktreeId,
    activeTabId: local.activeTabId ?? preserved.activeTabId,
    tabsByWorktree: {
      ...preserved.tabsByWorktree,
      ...local.tabsByWorktree
    },
    terminalLayoutsByTabId: {
      ...preserved.terminalLayoutsByTabId,
      ...local.terminalLayoutsByTabId
    },
    activeWorktreeIdsOnShutdown: [
      ...(preserved.activeWorktreeIdsOnShutdown ?? []),
      ...(local.activeWorktreeIdsOnShutdown ?? [])
    ],
    openFilesByWorktree: {
      ...preserved.openFilesByWorktree,
      ...local.openFilesByWorktree
    },
    activeFileIdByWorktree: {
      ...preserved.activeFileIdByWorktree,
      ...local.activeFileIdByWorktree
    },
    browserTabsByWorktree: {
      ...preserved.browserTabsByWorktree,
      ...local.browserTabsByWorktree
    },
    browserPagesByWorkspace: {
      ...preserved.browserPagesByWorkspace,
      ...local.browserPagesByWorkspace
    },
    activeBrowserTabIdByWorktree: {
      ...preserved.activeBrowserTabIdByWorktree,
      ...local.activeBrowserTabIdByWorktree
    },
    activeTabTypeByWorktree: {
      ...preserved.activeTabTypeByWorktree,
      ...local.activeTabTypeByWorktree
    },
    browserUrlHistory: local.browserUrlHistory,
    activeTabIdByWorktree: {
      ...preserved.activeTabIdByWorktree,
      ...local.activeTabIdByWorktree
    },
    unifiedTabs: {
      ...preserved.unifiedTabs,
      ...local.unifiedTabs
    },
    tabGroups: {
      ...preserved.tabGroups,
      ...local.tabGroups
    },
    tabGroupLayouts: {
      ...preserved.tabGroupLayouts,
      ...local.tabGroupLayouts
    },
    activeGroupIdByWorktree: {
      ...preserved.activeGroupIdByWorktree,
      ...local.activeGroupIdByWorktree
    },
    activeConnectionIdsAtShutdown: Array.from(
      new Set([
        ...(preserved.activeConnectionIdsAtShutdown ?? []),
        ...(local.activeConnectionIdsAtShutdown ?? [])
      ])
    ),
    remoteSessionIdsByTabId: {
      ...preserved.remoteSessionIdsByTabId,
      ...local.remoteSessionIdsByTabId
    },
    agentResumeBindingsByPaneKey: {
      ...preserved.agentResumeBindingsByPaneKey,
      ...local.agentResumeBindingsByPaneKey
    },
    lastVisitedAtByWorktreeId: {
      ...preserved.lastVisitedAtByWorktreeId,
      ...local.lastVisitedAtByWorktreeId
    }
  }
}
