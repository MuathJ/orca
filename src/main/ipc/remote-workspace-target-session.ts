import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/types'
import type { Store } from '../persistence'

function targetForWorktree(store: Store, worktreeId: string): string | null {
  const repoId = worktreeId.split('::')[0]
  const repo = store.getRepos().find((entry) => entry.id === repoId)
  return repo?.connectionId ?? null
}

function filterRecordByTarget<T>(
  store: Store,
  targetId: string,
  input: Record<string, T> | undefined,
  keyToWorktreeId: (key: string, value: T) => string | null
): Record<string, T> | undefined {
  if (!input) {
    return undefined
  }
  const entries = Object.entries(input).filter(([key, value]) => {
    const worktreeId = keyToWorktreeId(key, value)
    return worktreeId ? targetForWorktree(store, worktreeId) === targetId : false
  })
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export function filterSessionForRemoteWorkspaceTarget(
  store: Store,
  targetId: string,
  session: WorkspaceSessionState
): WorkspaceSessionState {
  const tabsByWorktree = filterRecordByTarget(
    store,
    targetId,
    session.tabsByWorktree,
    (worktreeId) => worktreeId
  )
  const browserTabsByWorktree = filterRecordByTarget(
    store,
    targetId,
    session.browserTabsByWorktree,
    (worktreeId) => worktreeId
  )
  const openFilesByWorktree = filterRecordByTarget(
    store,
    targetId,
    session.openFilesByWorktree,
    (worktreeId) => worktreeId
  )
  const activeFileIdByWorktree = filterRecordByTarget(
    store,
    targetId,
    session.activeFileIdByWorktree,
    (worktreeId) => worktreeId
  )
  const unifiedTabs = filterRecordByTarget(
    store,
    targetId,
    session.unifiedTabs,
    (worktreeId) => worktreeId
  )
  const tabGroups = filterRecordByTarget(
    store,
    targetId,
    session.tabGroups,
    (worktreeId) => worktreeId
  )
  const tabGroupLayouts = filterRecordByTarget(
    store,
    targetId,
    session.tabGroupLayouts,
    (worktreeId) => worktreeId
  )
  const activeGroupIdByWorktree = filterRecordByTarget(
    store,
    targetId,
    session.activeGroupIdByWorktree,
    (worktreeId) => worktreeId
  )
  const worktreeIds = new Set([
    ...Object.keys(tabsByWorktree ?? {}),
    ...Object.keys(browserTabsByWorktree ?? {}),
    ...Object.keys(openFilesByWorktree ?? {}),
    ...Object.keys(activeFileIdByWorktree ?? {}),
    ...Object.keys(unifiedTabs ?? {}),
    ...Object.keys(tabGroups ?? {}),
    ...Object.keys(tabGroupLayouts ?? {}),
    ...Object.keys(activeGroupIdByWorktree ?? {})
  ])
  if (session.activeWorktreeId && targetForWorktree(store, session.activeWorktreeId) === targetId) {
    worktreeIds.add(session.activeWorktreeId)
  }
  const terminalTabIds = new Set(
    Object.values(tabsByWorktree ?? {})
      .flat()
      .map((tab) => tab.id)
  )
  const browserWorkspaceIds = new Set(
    Object.values(browserTabsByWorktree ?? {})
      .flat()
      .map((tab) => tab.id)
  )

  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId:
      session.activeRepoId && store.getRepo(session.activeRepoId)?.connectionId === targetId
        ? session.activeRepoId
        : null,
    activeWorktreeId:
      session.activeWorktreeId && worktreeIds.has(session.activeWorktreeId)
        ? session.activeWorktreeId
        : null,
    activeTabId:
      session.activeTabId && terminalTabIds.has(session.activeTabId) ? session.activeTabId : null,
    tabsByWorktree: tabsByWorktree ?? {},
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(session.terminalLayoutsByTabId ?? {}).filter(([tabId]) =>
        terminalTabIds.has(tabId)
      )
    ),
    activeWorktreeIdsOnShutdown: session.activeWorktreeIdsOnShutdown?.filter((id) =>
      worktreeIds.has(id)
    ),
    openFilesByWorktree,
    activeFileIdByWorktree,
    browserTabsByWorktree,
    browserPagesByWorkspace: session.browserPagesByWorkspace
      ? Object.fromEntries(
          Object.entries(session.browserPagesByWorkspace).filter(([workspaceId]) =>
            browserWorkspaceIds.has(workspaceId)
          )
        )
      : undefined,
    activeBrowserTabIdByWorktree: filterRecordByTarget(
      store,
      targetId,
      session.activeBrowserTabIdByWorktree,
      (worktreeId) => worktreeId
    ),
    activeTabTypeByWorktree: filterRecordByTarget(
      store,
      targetId,
      session.activeTabTypeByWorktree,
      (worktreeId) => worktreeId
    ),
    browserUrlHistory: session.browserUrlHistory,
    activeTabIdByWorktree: filterRecordByTarget(
      store,
      targetId,
      session.activeTabIdByWorktree,
      (worktreeId) => worktreeId
    ),
    unifiedTabs,
    tabGroups,
    tabGroupLayouts,
    activeGroupIdByWorktree,
    activeConnectionIdsAtShutdown: [targetId],
    remoteSessionIdsByTabId: session.remoteSessionIdsByTabId
      ? Object.fromEntries(
          Object.entries(session.remoteSessionIdsByTabId).filter(([tabId]) =>
            terminalTabIds.has(tabId)
          )
        )
      : undefined,
    agentResumeBindingsByPaneKey: session.agentResumeBindingsByPaneKey
      ? Object.fromEntries(
          Object.entries(session.agentResumeBindingsByPaneKey).filter(([paneKey]) => {
            const tabId = paneKey.split(':')[0]
            return Boolean(tabId && terminalTabIds.has(tabId))
          })
        )
      : undefined,
    lastVisitedAtByWorktreeId: filterRecordByTarget(
      store,
      targetId,
      session.lastVisitedAtByWorktreeId,
      (worktreeId) => worktreeId
    )
  }
}
