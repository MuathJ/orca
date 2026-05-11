import { randomUUID } from 'crypto'
import { ipcMain } from 'electron'
import { hostname } from 'os'
import type { Store } from '../persistence'
import { getActiveMultiplexer, getSshConnectionStore } from './ssh'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { parseWorkspaceSession } from '../../shared/workspace-session-schema'
import type {
  RemoteWorkspaceConnectedClient,
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { WorkspaceSessionState } from '../../shared/types'
import type { SshTarget } from '../../shared/ssh-types'
import { getRemoteWorkspaceNamespace } from './remote-workspace-namespace'
import { mergeLocalSessionWithRemoteOutsideScope } from './remote-workspace-scope-merge'
import { filterSessionForRemoteWorkspaceTarget } from './remote-workspace-target-session'

const CLIENT_ID = randomUUID()
const CLIENT_NAME = hostname() || 'This device'

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

function normalizeConnectedClients(
  raw: unknown,
  currentClientId: string
): RemoteWorkspaceConnectedClient[] {
  const clients = (raw as { clients?: unknown } | null)?.clients
  if (!Array.isArray(clients)) {
    return []
  }
  return clients
    .map((entry): RemoteWorkspaceConnectedClient | null => {
      const item = entry as Partial<RemoteWorkspaceConnectedClient> | null
      if (!item) {
        return null
      }
      const clientId = typeof item?.clientId === 'string' ? item.clientId.trim() : ''
      if (!clientId || clientId.length > 200) {
        return null
      }
      const lastSeenAt =
        typeof item.lastSeenAt === 'number' && Number.isFinite(item.lastSeenAt)
          ? item.lastSeenAt
          : 0
      const name =
        typeof item.name === 'string' && item.name.trim()
          ? item.name.replace(/\s+/g, ' ').trim().slice(0, 80)
          : 'Unknown device'
      return {
        clientId,
        name,
        lastSeenAt,
        isCurrent: clientId === currentClientId
      }
    })
    .filter((entry): entry is RemoteWorkspaceConnectedClient => entry !== null)
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
  ipcMain.removeHandler('remoteWorkspace:listConnectedClients')
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

  ipcMain.handle(
    'remoteWorkspace:listConnectedClients',
    async (_event, args?: { targetIds?: string[] }) => {
      const requestedTargetIds = Array.isArray(args?.targetIds) ? new Set(args.targetIds) : null
      const targets =
        getSshConnectionStore()
          ?.listTargets()
          .filter(
            (target) =>
              target.remoteWorkspaceSyncEnabled &&
              getActiveMultiplexer(target.id) &&
              (!requestedTargetIds || requestedTargetIds.has(target.id))
          ) ?? []
      const results: { targetId: string; clients: RemoteWorkspaceConnectedClient[] }[] = []
      for (const target of targets) {
        const mux = getActiveMultiplexer(target.id)
        if (!mux) {
          continue
        }
        const namespace = getRemoteWorkspaceNamespace(target)
        let raw: unknown
        try {
          raw = await mux.request('workspace.presence', {
            namespace,
            clientId: CLIENT_ID,
            clientName: CLIENT_NAME
          })
        } catch {
          // Why: existing remote relays can stay alive across app updates and
          // may not expose workspace.presence yet. Device presence is best-effort
          // UI metadata, so don't turn an old relay into a noisy IPC failure.
          raw = { clients: [] }
        }
        results.push({
          targetId: target.id,
          clients: normalizeConnectedClients(raw, CLIENT_ID)
        })
      }
      return results
    }
  )

  ipcMain.handle('remoteWorkspace:clientId', () => CLIENT_ID)
}
