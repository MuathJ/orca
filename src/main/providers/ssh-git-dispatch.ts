import type { IGitProvider } from './types'

const sshProviders = new Map<string, IGitProvider>()
const SSH_GIT_PROVIDER_WAIT_MS = 10_000
const sshProviderWaiters = new Map<string, Set<(provider: IGitProvider | null) => void>>()

function resolveGitProviderWaiters(connectionId: string, provider: IGitProvider | null): void {
  const waiters = sshProviderWaiters.get(connectionId)
  if (!waiters) {
    return
  }
  sshProviderWaiters.delete(connectionId)
  for (const resolve of waiters) {
    resolve(provider)
  }
}

export function registerSshGitProvider(connectionId: string, provider: IGitProvider): void {
  sshProviders.set(connectionId, provider)
  resolveGitProviderWaiters(connectionId, provider)
}

export function unregisterSshGitProvider(connectionId: string): void {
  sshProviders.delete(connectionId)
  resolveGitProviderWaiters(connectionId, null)
}

export function getSshGitProvider(connectionId: string): IGitProvider | undefined {
  return sshProviders.get(connectionId)
}

export async function waitForSshGitProvider(connectionId: string): Promise<IGitProvider | null> {
  const provider = sshProviders.get(connectionId)
  if (provider) {
    return provider
  }

  return new Promise((resolve) => {
    let settled = false
    const resolveOnce = (value: IGitProvider | null): void => {
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

    const timer = setTimeout(() => resolveOnce(null), SSH_GIT_PROVIDER_WAIT_MS)
    ;(timer as { unref?: () => void }).unref?.()
    const waiters = sshProviderWaiters.get(connectionId) ?? new Set()
    waiters.add(resolveOnce)
    sshProviderWaiters.set(connectionId, waiters)
  })
}
