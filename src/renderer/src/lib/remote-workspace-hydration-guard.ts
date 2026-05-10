let remoteWorkspaceHydrationDepth = 0

export function isRemoteWorkspaceHydrating(): boolean {
  return remoteWorkspaceHydrationDepth > 0
}

export async function runDuringRemoteWorkspaceHydration<T>(fn: () => Promise<T>): Promise<T> {
  remoteWorkspaceHydrationDepth++
  try {
    return await fn()
  } finally {
    remoteWorkspaceHydrationDepth--
  }
}
