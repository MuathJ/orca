import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { RelayDispatcher } from './dispatcher'

type RemoteWorkspaceSnapshot = {
  namespace: string
  revision: number
  updatedAt: number
  session: Record<string, unknown>
}

type PatchResult =
  | { ok: true; snapshot: RemoteWorkspaceSnapshot }
  | {
      ok: false
      reason: 'stale-revision' | 'unavailable'
      snapshot?: RemoteWorkspaceSnapshot
      message?: string
    }

function emptySession(): Record<string, unknown> {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

function sanitizeNamespace(namespace: unknown): string {
  const raw = typeof namespace === 'string' && namespace.trim() ? namespace.trim() : 'default'
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'default'
}

export class WorkspaceSessionHandler {
  private readonly baseDir: string

  constructor(
    private dispatcher: RelayDispatcher,
    baseDir = join(homedir(), '.orca', 'sessions')
  ) {
    this.baseDir = baseDir
    this.dispatcher.onRequest('workspace.get', (params) => this.get(params))
    this.dispatcher.onRequest('workspace.patch', (params) => this.patch(params))
  }

  private snapshotPath(namespace: string): string {
    return join(this.baseDir, `${namespace}.json`)
  }

  private read(namespace: string): RemoteWorkspaceSnapshot {
    const path = this.snapshotPath(namespace)
    if (!existsSync(path)) {
      return {
        namespace,
        revision: 0,
        updatedAt: 0,
        session: emptySession()
      }
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RemoteWorkspaceSnapshot>
      return {
        namespace,
        revision:
          typeof parsed.revision === 'number' && Number.isFinite(parsed.revision)
            ? parsed.revision
            : 0,
        updatedAt:
          typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
            ? parsed.updatedAt
            : 0,
        session:
          parsed.session && typeof parsed.session === 'object' && !Array.isArray(parsed.session)
            ? (parsed.session as Record<string, unknown>)
            : emptySession()
      }
    } catch {
      return {
        namespace,
        revision: 0,
        updatedAt: 0,
        session: emptySession()
      }
    }
  }

  private write(snapshot: RemoteWorkspaceSnapshot): void {
    const path = this.snapshotPath(snapshot.namespace)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmpPath = `${path}.tmp`
    writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), { mode: 0o600 })
    renameSync(tmpPath, path)
  }

  private async get(params: Record<string, unknown>): Promise<RemoteWorkspaceSnapshot> {
    return this.read(sanitizeNamespace(params.namespace))
  }

  private async patch(params: Record<string, unknown>): Promise<PatchResult> {
    const namespace = sanitizeNamespace(params.namespace)
    const current = this.read(namespace)
    const baseRevision = Number(params.baseRevision)
    if (Number.isFinite(baseRevision) && baseRevision !== current.revision) {
      return { ok: false, reason: 'stale-revision', snapshot: current }
    }
    const patch = params.patch as { kind?: unknown; session?: unknown } | undefined
    if (
      !patch ||
      patch.kind !== 'replace-session' ||
      !patch.session ||
      typeof patch.session !== 'object' ||
      Array.isArray(patch.session)
    ) {
      return { ok: false, reason: 'unavailable', message: 'Invalid workspace patch' }
    }
    const snapshot: RemoteWorkspaceSnapshot = {
      namespace,
      revision: current.revision + 1,
      updatedAt: Date.now(),
      session: patch.session as Record<string, unknown>
    }
    this.write(snapshot)
    this.dispatcher.notify('workspace.changed', {
      namespace,
      snapshot,
      sourceClientId: typeof params.clientId === 'string' ? params.clientId : undefined
    })
    return { ok: true, snapshot }
  }
}
