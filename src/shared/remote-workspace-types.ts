import type { WorkspaceSessionState } from './types'

export type RemoteWorkspaceSnapshot = {
  namespace: string
  revision: number
  updatedAt: number
  session: WorkspaceSessionState
}

export type RemoteWorkspaceConnectedClient = {
  clientId: string
  name: string
  lastSeenAt: number
  isCurrent?: boolean
}

export type RemoteWorkspacePatch = {
  kind: 'replace-session'
  session: WorkspaceSessionState
}

export type RemoteWorkspacePatchResult =
  | {
      ok: true
      snapshot: RemoteWorkspaceSnapshot
    }
  | {
      ok: false
      reason: 'stale-revision' | 'unavailable'
      snapshot?: RemoteWorkspaceSnapshot
      message?: string
    }

export type RemoteWorkspaceChangedEvent = {
  targetId: string
  snapshot: RemoteWorkspaceSnapshot
  sourceClientId?: string
}
