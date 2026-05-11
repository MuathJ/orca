/* oxlint-disable max-lines -- Why: these IPC tests share one mocked Electron/relay setup; splitting would duplicate module-hoist state and make stale-revision coverage harder to follow. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { Repo, WorkspaceSessionState } from '../../shared/types'
import type { SshTarget } from '../../shared/ssh-types'

const { handlers, mux, sshStore } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>(),
  mux: {
    request: vi.fn()
  },
  sshStore: {
    getTarget: vi.fn(),
    listTargets: vi.fn()
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    handle: vi.fn(
      (
        channel: string,
        handler: (_event: unknown, args: unknown) => Promise<unknown> | unknown
      ) => {
        handlers.set(channel, handler)
      }
    )
  }
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: vi.fn(() => mux),
  getSshConnectionStore: vi.fn(() => sshStore)
}))

const target: SshTarget = {
  id: 'target-1',
  label: 'Remote',
  host: 'dev.example.com',
  port: 22,
  username: 'dev',
  remoteWorkspaceSyncEnabled: true
}

const remoteRepo: Repo = {
  id: 'repo-remote',
  path: '/repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'git',
  connectionId: 'target-1'
}

function createStore() {
  return {
    getRepos: vi.fn(() => [remoteRepo]),
    getRepo: vi.fn((repoId: string) => (repoId === remoteRepo.id ? remoteRepo : undefined))
  }
}

describe('registerRemoteWorkspaceHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    sshStore.getTarget.mockReturnValue(target)
    sshStore.listTargets.mockReturnValue([target])
    mux.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'workspace.get') {
        return {
          namespace: params.namespace,
          revision: 0,
          updatedAt: 0,
          session: getDefaultWorkspaceSession()
        }
      }
      if (method === 'workspace.patch') {
        return {
          ok: true,
          snapshot: {
            namespace: params.namespace,
            revision: 1,
            updatedAt: 1,
            session: (params.patch as { session: WorkspaceSessionState }).session
          }
        }
      }
      if (method === 'workspace.presence') {
        return {
          clients: [
            {
              clientId: params.clientId,
              name: params.clientName,
              lastSeenAt: 100
            },
            {
              clientId: 'other-client',
              name: 'Work laptop',
              lastSeenAt: 90
            }
          ]
        }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
  })

  it('keeps editor-only remote workspaces in the synced target slice', async () => {
    const { registerRemoteWorkspaceHandlers } = await import('./remote-workspace')
    const store = createStore()
    registerRemoteWorkspaceHandlers(store as never)

    const worktreeId = `${remoteRepo.id}::/repo`
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: remoteRepo.id,
      activeWorktreeId: worktreeId,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [worktreeId]: [
          {
            filePath: '/repo/README.md',
            relativePath: 'README.md',
            worktreeId,
            language: 'markdown'
          }
        ]
      },
      activeFileIdByWorktree: {
        [worktreeId]: '/repo/README.md'
      },
      unifiedTabs: {
        [worktreeId]: [
          {
            id: 'tab-editor',
            entityId: '/repo/README.md',
            groupId: 'group-1',
            worktreeId,
            contentType: 'editor',
            label: 'README.md',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    }

    const handler = handlers.get('remoteWorkspace:setForConnectedTargets')
    expect(handler).toBeDefined()
    await handler?.(null, { session })

    const patchCall = mux.request.mock.calls.find(([method]) => method === 'workspace.patch')
    expect(patchCall).toBeDefined()
    if (!patchCall) {
      throw new Error('workspace.patch was not called')
    }
    const patchSession = (patchCall[1].patch as { session: WorkspaceSessionState }).session
    expect(patchSession.activeRepoId).toBe(remoteRepo.id)
    expect(patchSession.activeWorktreeId).toBe(worktreeId)
    expect(patchSession.openFilesByWorktree?.[worktreeId]).toHaveLength(1)
    expect(patchSession.unifiedTabs?.[worktreeId]?.[0]?.contentType).toBe('editor')
  })

  it('lists connected remote workspace clients with the current device marked', async () => {
    const { registerRemoteWorkspaceHandlers } = await import('./remote-workspace')
    const store = createStore()
    registerRemoteWorkspaceHandlers(store as never)

    const handler = handlers.get('remoteWorkspace:listConnectedClients')
    const result = (await handler?.(null, { targetIds: ['target-1'] })) as {
      targetId: string
      clients: { clientId: string; name: string; isCurrent?: boolean }[]
    }[]

    expect(result).toHaveLength(1)
    expect(result[0].targetId).toBe('target-1')
    expect(result[0].clients[0]).toMatchObject({ name: expect.any(String), isCurrent: true })
    expect(result[0].clients[1]).toMatchObject({ name: 'Work laptop', isCurrent: false })
  })

  it('treats missing workspace presence support as unavailable metadata', async () => {
    const { registerRemoteWorkspaceHandlers } = await import('./remote-workspace')
    const store = createStore()
    mux.request.mockImplementation(async (method: string) => {
      if (method === 'workspace.presence') {
        throw new Error('Method not found: workspace.presence')
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    registerRemoteWorkspaceHandlers(store as never)

    const handler = handlers.get('remoteWorkspace:listConnectedClients')
    const result = (await handler?.(null, { targetIds: ['target-1'] })) as {
      targetId: string
      clients: unknown[]
    }[]

    expect(result).toEqual([{ targetId: 'target-1', clients: [] }])
  })

  it('does not push a target before the renderer has hydrated it', async () => {
    const { registerRemoteWorkspaceHandlers } = await import('./remote-workspace')
    const store = createStore()
    registerRemoteWorkspaceHandlers(store as never)

    const handler = handlers.get('remoteWorkspace:setForConnectedTargets')
    expect(handler).toBeDefined()
    const result = await handler?.(null, {
      session: getDefaultWorkspaceSession(),
      hydratedTargetIds: []
    })

    expect(result).toEqual([])
    expect(mux.request).not.toHaveBeenCalledWith('workspace.patch', expect.anything())
  })

  it('preserves remote worktrees outside the local target scope when pushing', async () => {
    const { registerRemoteWorkspaceHandlers } = await import('./remote-workspace')
    const store = createStore()
    const localWorktreeId = `${remoteRepo.id}::/repo`
    const remoteOnlyWorktreeId = 'repo-other::/other'
    const remoteOnlyTab = {
      id: 'tab-remote-only',
      ptyId: 'pty-remote-only',
      worktreeId: remoteOnlyWorktreeId,
      title: 'Remote only',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    mux.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'workspace.get') {
        return {
          namespace: params.namespace,
          revision: 7,
          updatedAt: 7,
          session: {
            ...getDefaultWorkspaceSession(),
            tabsByWorktree: {
              [localWorktreeId]: [
                {
                  ...remoteOnlyTab,
                  id: 'tab-stale-local',
                  ptyId: 'pty-stale-local',
                  worktreeId: localWorktreeId
                }
              ],
              [remoteOnlyWorktreeId]: [remoteOnlyTab]
            },
            terminalLayoutsByTabId: {
              'tab-remote-only': {
                root: { type: 'leaf', leafId: 'leaf-remote-only' },
                activeLeafId: 'leaf-remote-only',
                expandedLeafId: null,
                ptyIdsByLeafId: { 'leaf-remote-only': 'pty-remote-only' }
              }
            },
            remoteSessionIdsByTabId: {
              'tab-remote-only': 'pty-remote-only'
            }
          }
        }
      }
      if (method === 'workspace.patch') {
        return {
          ok: true,
          snapshot: {
            namespace: params.namespace,
            revision: 8,
            updatedAt: 8,
            session: (params.patch as { session: WorkspaceSessionState }).session
          }
        }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    registerRemoteWorkspaceHandlers(store as never)

    const handler = handlers.get('remoteWorkspace:setForConnectedTargets')
    await handler?.(null, {
      session: {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: {}
      },
      hydratedTargetIds: [target.id],
      targetScopes: {
        [target.id]: { worktreePaths: ['/repo'] }
      }
    })

    const patchCall = mux.request.mock.calls.find(([method]) => method === 'workspace.patch')
    expect(patchCall).toBeDefined()
    if (!patchCall) {
      throw new Error('workspace.patch was not called')
    }
    const patchSession = (patchCall[1].patch as { session: WorkspaceSessionState }).session
    expect(patchSession.tabsByWorktree[localWorktreeId]).toBeUndefined()
    expect(patchSession.tabsByWorktree[remoteOnlyWorktreeId]).toEqual([remoteOnlyTab])
    expect(patchSession.remoteSessionIdsByTabId?.['tab-remote-only']).toBe('pty-remote-only')
  })

  it('re-merges scoped pushes against the fresh snapshot after stale revision', async () => {
    const { registerRemoteWorkspaceHandlers } = await import('./remote-workspace')
    const store = createStore()
    const localWorktreeId = `${remoteRepo.id}::/repo`
    const staleRemoteWorktreeId = 'repo-other::/other'
    const freshRemoteWorktreeId = 'repo-fresh::/fresh'
    const staleRemoteTab = {
      id: 'tab-stale-remote',
      ptyId: 'pty-stale-remote',
      worktreeId: staleRemoteWorktreeId,
      title: 'Stale remote',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const freshRemoteTab = {
      ...staleRemoteTab,
      id: 'tab-fresh-remote',
      ptyId: 'pty-fresh-remote',
      worktreeId: freshRemoteWorktreeId,
      title: 'Fresh remote'
    }
    let patchCount = 0
    mux.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'workspace.get') {
        return {
          namespace: params.namespace,
          revision: 7,
          updatedAt: 7,
          session: {
            ...getDefaultWorkspaceSession(),
            tabsByWorktree: { [staleRemoteWorktreeId]: [staleRemoteTab] }
          }
        }
      }
      if (method === 'workspace.patch') {
        patchCount += 1
        if (patchCount === 1) {
          return {
            ok: false,
            reason: 'stale-revision',
            snapshot: {
              namespace: params.namespace,
              revision: 8,
              updatedAt: 8,
              session: {
                ...getDefaultWorkspaceSession(),
                tabsByWorktree: { [freshRemoteWorktreeId]: [freshRemoteTab] }
              }
            }
          }
        }
        return {
          ok: true,
          snapshot: {
            namespace: params.namespace,
            revision: 9,
            updatedAt: 9,
            session: (params.patch as { session: WorkspaceSessionState }).session
          }
        }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    registerRemoteWorkspaceHandlers(store as never)

    const handler = handlers.get('remoteWorkspace:setForConnectedTargets')
    await handler?.(null, {
      session: {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: {}
      },
      hydratedTargetIds: [target.id],
      targetScopes: {
        [target.id]: { worktreePaths: ['/repo'] }
      }
    })

    const patchCalls = mux.request.mock.calls.filter(([method]) => method === 'workspace.patch')
    expect(patchCalls).toHaveLength(2)
    const retrySession = (patchCalls[1]![1].patch as { session: WorkspaceSessionState }).session
    expect(retrySession.tabsByWorktree[localWorktreeId]).toBeUndefined()
    expect(retrySession.tabsByWorktree[staleRemoteWorktreeId]).toBeUndefined()
    expect(retrySession.tabsByWorktree[freshRemoteWorktreeId]).toEqual([freshRemoteTab])
  })
})
