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
})
