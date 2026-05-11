let remoteWorkspaceHydrationDepth = 0
let lastRemoteWorkspaceHydrationAt = 0

export function isRemoteWorkspaceHydrating(): boolean {
  return remoteWorkspaceHydrationDepth > 0
}

export function getLastRemoteWorkspaceHydrationAt(): number {
  return lastRemoteWorkspaceHydrationAt
}

export async function runDuringRemoteWorkspaceHydration<T>(fn: () => Promise<T>): Promise<T> {
  lastRemoteWorkspaceHydrationAt = Date.now()
  remoteWorkspaceHydrationDepth++
  try {
    return await fn()
  } finally {
    lastRemoteWorkspaceHydrationAt = Date.now()
    remoteWorkspaceHydrationDepth--
  }
}
