import type { IFilesystemProvider } from './types'

const sshProviders = new Map<string, IFilesystemProvider>()
const SSH_FILESYSTEM_PROVIDER_WAIT_MS = 10_000
const sshProviderWaiters = new Map<string, Set<(provider: IFilesystemProvider | null) => void>>()

function resolveFilesystemProviderWaiters(
  connectionId: string,
  provider: IFilesystemProvider | null
): void {
  const waiters = sshProviderWaiters.get(connectionId)
  if (!waiters) {
    return
  }
  sshProviderWaiters.delete(connectionId)
  for (const resolve of waiters) {
    resolve(provider)
  }
}

export function registerSshFilesystemProvider(
  connectionId: string,
  provider: IFilesystemProvider
): void {
  sshProviders.set(connectionId, provider)
  resolveFilesystemProviderWaiters(connectionId, provider)
}

export function unregisterSshFilesystemProvider(connectionId: string): void {
  sshProviders.delete(connectionId)
  resolveFilesystemProviderWaiters(connectionId, null)
}

export function getSshFilesystemProvider(connectionId: string): IFilesystemProvider | undefined {
  return sshProviders.get(connectionId)
}

export async function waitForSshFilesystemProvider(
  connectionId: string
): Promise<IFilesystemProvider | null> {
  const provider = sshProviders.get(connectionId)
  if (provider) {
    return provider
  }

  return new Promise((resolve) => {
    let settled = false
    const resolveOnce = (value: IFilesystemProvider | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      const waiters = sshProviderWaiters.get(connectionId)
      waiters?.delete(resolveOnce)
      if (waiters?.size === 0) {
        sshProviderWaiters.delete(connectionId)
      }
      resolve(value)
    }

    const timer = setTimeout(() => resolveOnce(null), SSH_FILESYSTEM_PROVIDER_WAIT_MS)
    ;(timer as { unref?: () => void }).unref?.()
    const waiters = sshProviderWaiters.get(connectionId) ?? new Set()
    waiters.add(resolveOnce)
    sshProviderWaiters.set(connectionId, waiters)
  })
}
