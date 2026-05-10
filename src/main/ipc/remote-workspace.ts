import { createHash, randomUUID } from 'crypto'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { getActiveMultiplexer, getSshConnectionStore } from './ssh'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { parseWorkspaceSession } from '../../shared/workspace-session-schema'
import type {
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { WorkspaceSessionState } from '../../shared/types'
import type { SshTarget } from '../../shared/ssh-types'

const CLIENT_ID = randomUUID()

function getNamespace(target: SshTarget): string {
  const stableKey = [
    target.configHost || target.host,
    target.host,
    String(target.port),
    target.username
  ].join('\n')
  return createHash('sha256').update(stableKey).digest('hex').slice(0, 32)
}

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

function filterSessionForTarget(
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
    lastVisitedAtByWorktreeId: filterRecordByTarget(
      store,
      targetId,
      session.lastVisitedAtByWorktreeId,
      (worktreeId) => worktreeId
    )
  }
}

function normalizeSnapshot(raw: unknown, fallbackNamespace: string): RemoteWorkspaceSnapshot {
  const input = raw as Partial<RemoteWorkspaceSnapshot> | null
  const parsed = parseWorkspaceSession(input?.session)
  return {
    namespace: typeof input?.namespace === 'string' ? input.namespace : fallbackNamespace,
    revision:
      typeof input?.revision === 'number' && Number.isFinite(input.revision) ? input.revision : 0,
    updatedAt:
      typeof input?.updatedAt === 'number' && Number.isFinite(input.updatedAt)
        ? input.updatedAt
        : 0,
    session: parsed.ok ? parsed.value : getDefaultWorkspaceSession()
  }
}

async function getRemoteSnapshot(target: SshTarget): Promise<RemoteWorkspaceSnapshot | null> {
  if (!target.remoteWorkspaceSyncEnabled) {
    return null
  }
  const mux = getActiveMultiplexer(target.id)
  if (!mux) {
    return null
  }
  const namespace = getNamespace(target)
  const raw = await mux.request('workspace.get', { namespace })
  return normalizeSnapshot(raw, namespace)
}

export function registerRemoteWorkspaceHandlers(store: Store): void {
  ipcMain.removeHandler('remoteWorkspace:get')
  ipcMain.removeHandler('remoteWorkspace:setForConnectedTargets')
  ipcMain.removeHandler('remoteWorkspace:listEnabledConnectedTargets')
  ipcMain.removeHandler('remoteWorkspace:clientId')

  ipcMain.handle('remoteWorkspace:get', async (_event, args: { targetId: string }) => {
    const target = getSshConnectionStore()?.getTarget(args.targetId)
    if (!target) {
      return null
    }
    return getRemoteSnapshot(target)
  })

  ipcMain.handle(
    'remoteWorkspace:setForConnectedTargets',
    async (_event, args: { session: WorkspaceSessionState }) => {
      const targets = getSshConnectionStore()
        ?.listTargets()
        .filter((target) => target.remoteWorkspaceSyncEnabled && getActiveMultiplexer(target.id))
      if (!targets || targets.length === 0) {
        return []
      }

      const results: { targetId: string; result: RemoteWorkspacePatchResult }[] = []
      for (const target of targets) {
        const mux = getActiveMultiplexer(target.id)
        if (!mux) {
          continue
        }
        const namespace = getNamespace(target)
        const current = await getRemoteSnapshot(target)
        const session = filterSessionForTarget(store, target.id, args.session)
        let result = (await mux.request('workspace.patch', {
          namespace,
          baseRevision: current?.revision ?? 0,
          clientId: CLIENT_ID,
          patch: { kind: 'replace-session', session }
        })) as RemoteWorkspacePatchResult
        if (!result.ok && result.reason === 'stale-revision' && result.snapshot) {
          result = (await mux.request('workspace.patch', {
            namespace,
            baseRevision: result.snapshot.revision,
            clientId: CLIENT_ID,
            patch: { kind: 'replace-session', session }
          })) as RemoteWorkspacePatchResult
        }
        results.push({ targetId: target.id, result })
      }
      return results
    }
  )

  ipcMain.handle('remoteWorkspace:listEnabledConnectedTargets', async () => {
    return (
      getSshConnectionStore()
        ?.listTargets()
        .filter((target) => target.remoteWorkspaceSyncEnabled && getActiveMultiplexer(target.id))
        .map((target) => target.id) ?? []
    )
  })

  ipcMain.handle('remoteWorkspace:clientId', () => CLIENT_ID)
}
