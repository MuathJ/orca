import { randomUUID } from 'crypto'
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
import { getRemoteWorkspaceNamespace } from './remote-workspace-namespace'
import { mergeLocalSessionWithRemoteOutsideScope } from './remote-workspace-scope-merge'
import { filterSessionForRemoteWorkspaceTarget } from './remote-workspace-target-session'

const CLIENT_ID = randomUUID()

type RemoteWorkspaceSetArgs = {
  session: WorkspaceSessionState
  hydratedTargetIds?: string[]
  targetScopes?: Record<string, { worktreePaths?: string[] }>
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
  const namespace = getRemoteWorkspaceNamespace(target)
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
    async (_event, args: RemoteWorkspaceSetArgs) => {
      const hydratedTargetIds = Array.isArray(args.hydratedTargetIds)
        ? new Set(args.hydratedTargetIds)
        : null
      const targets = getSshConnectionStore()
        ?.listTargets()
        .filter((target) => target.remoteWorkspaceSyncEnabled && getActiveMultiplexer(target.id))
      if (!targets || targets.length === 0) {
        return []
      }

      const results: { targetId: string; result: RemoteWorkspacePatchResult }[] = []
      for (const target of targets) {
        if (hydratedTargetIds && !hydratedTargetIds.has(target.id)) {
          continue
        }
        const mux = getActiveMultiplexer(target.id)
        if (!mux) {
          continue
        }
        const namespace = getRemoteWorkspaceNamespace(target)
        const current = await getRemoteSnapshot(target)
        const localSession = filterSessionForRemoteWorkspaceTarget(store, target.id, args.session)
        const scope = args.targetScopes?.[target.id]
        const knownWorktreePaths = new Set(scope?.worktreePaths?.filter(Boolean) ?? [])
        if (scope && knownWorktreePaths.size === 0) {
          continue
        }
        let session =
          current && scope
            ? mergeLocalSessionWithRemoteOutsideScope(
                current.session,
                localSession,
                knownWorktreePaths
              )
            : localSession
        let result = (await mux.request('workspace.patch', {
          namespace,
          baseRevision: current?.revision ?? 0,
          clientId: CLIENT_ID,
          patch: { kind: 'replace-session', session }
        })) as RemoteWorkspacePatchResult
        if (!result.ok && result.reason === 'stale-revision' && result.snapshot) {
          if (scope) {
            // Why: stale retries must preserve out-of-scope edits made after
            // our initial get; the server-provided snapshot is the new base.
            session = mergeLocalSessionWithRemoteOutsideScope(
              result.snapshot.session,
              localSession,
              knownWorktreePaths
            )
          }
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

  ipcMain.handle(
    'remoteWorkspace:listEnabledConnectedTargets',
    async () =>
      getSshConnectionStore()
        ?.listTargets()
        .filter((target) => target.remoteWorkspaceSyncEnabled && getActiveMultiplexer(target.id))
        .map((target) => target.id) ?? []
  )

  ipcMain.handle('remoteWorkspace:clientId', () => CLIENT_ID)
}
