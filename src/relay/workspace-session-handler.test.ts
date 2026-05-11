import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSessionHandler } from './workspace-session-handler'
import type { RelayDispatcher } from './dispatcher'

function createMockDispatcher() {
  const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
  const notifications: { method: string; params?: Record<string, unknown> }[] = []

  return {
    onRequest: vi.fn(
      (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
        requestHandlers.set(method, handler)
      }
    ),
    notify: vi.fn((method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params })
    }),
    async callRequest(method: string, params: Record<string, unknown> = {}) {
      const handler = requestHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      return handler(params)
    },
    notifications
  }
}

describe('WorkspaceSessionHandler', () => {
  let dispatcher: ReturnType<typeof createMockDispatcher>
  let baseDir: string

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'orca-workspace-session-test-'))
    dispatcher = createMockDispatcher()
    new WorkspaceSessionHandler(dispatcher as unknown as RelayDispatcher, baseDir)
  })

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('starts with an empty snapshot for a new namespace', async () => {
    const snapshot = await dispatcher.callRequest('workspace.get', { namespace: 'target-a' })

    expect(snapshot).toMatchObject({
      namespace: 'target-a',
      revision: 0,
      session: {
        activeRepoId: null,
        activeWorktreeId: null,
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {}
      }
    })
  })

  it('persists replacement patches and broadcasts changes', async () => {
    const result = await dispatcher.callRequest('workspace.patch', {
      namespace: 'target-a',
      baseRevision: 0,
      clientId: 'client-1',
      patch: {
        kind: 'replace-session',
        session: {
          activeRepoId: 'repo-1',
          activeWorktreeId: null,
          activeTabId: null,
          tabsByWorktree: {},
          terminalLayoutsByTabId: {}
        }
      }
    })

    expect(result).toMatchObject({ ok: true, snapshot: { revision: 1 } })
    const snapshot = await dispatcher.callRequest('workspace.get', { namespace: 'target-a' })
    expect(snapshot).toMatchObject({ revision: 1, session: { activeRepoId: 'repo-1' } })
    expect(dispatcher.notifications).toHaveLength(1)
    expect(dispatcher.notifications[0]).toMatchObject({
      method: 'workspace.changed',
      params: { sourceClientId: 'client-1' }
    })
  })

  it('rejects stale base revisions without overwriting the snapshot', async () => {
    await dispatcher.callRequest('workspace.patch', {
      namespace: 'target-a',
      baseRevision: 0,
      patch: {
        kind: 'replace-session',
        session: {
          activeRepoId: 'repo-1',
          activeWorktreeId: null,
          activeTabId: null,
          tabsByWorktree: {},
          terminalLayoutsByTabId: {}
        }
      }
    })

    const result = await dispatcher.callRequest('workspace.patch', {
      namespace: 'target-a',
      baseRevision: 0,
      patch: {
        kind: 'replace-session',
        session: {
          activeRepoId: 'repo-2',
          activeWorktreeId: null,
          activeTabId: null,
          tabsByWorktree: {},
          terminalLayoutsByTabId: {}
        }
      }
    })

    expect(result).toMatchObject({
      ok: false,
      reason: 'stale-revision',
      snapshot: { revision: 1, session: { activeRepoId: 'repo-1' } }
    })
  })

  it('tracks connected workspace clients by namespace', async () => {
    const result = await dispatcher.callRequest('workspace.presence', {
      namespace: 'target-a',
      clientId: 'client-1',
      clientName: 'MacBook Pro'
    })

    expect(result).toMatchObject({
      clients: [
        {
          clientId: 'client-1',
          name: 'MacBook Pro'
        }
      ]
    })
  })
})
