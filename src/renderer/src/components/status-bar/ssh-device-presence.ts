import { useEffect, useState } from 'react'
import type { RemoteWorkspaceConnectedClient } from '../../../../shared/remote-workspace-types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'

const DEVICE_PRESENCE_POLL_MS = 15_000

export function devicePresenceText(
  clients: RemoteWorkspaceConnectedClient[] | undefined,
  status: SshConnectionStatus
): string {
  if (status !== 'connected') {
    return 'No connected devices'
  }
  if (!clients) {
    return 'Checking devices…'
  }
  if (clients.length === 0) {
    return 'Devices unavailable'
  }
  const names = clients
    .slice(0, 3)
    .map((client) => (client.isCurrent ? `${client.name} (this device)` : client.name))
  const prefix = `${clients.length} ${clients.length === 1 ? 'device' : 'devices'}`
  const suffix = clients.length > 3 ? `, +${clients.length - 3} more` : ''
  return `${prefix}: ${names.join(', ')}${suffix}`
}

export function devicePresenceName(client: RemoteWorkspaceConnectedClient): string {
  return client.isCurrent ? `${client.name} (this device)` : client.name
}

export function useSshDevicePresence(
  presenceTargetIdsKey: string
): Record<string, RemoteWorkspaceConnectedClient[]> {
  const [connectedClientsByTargetId, setConnectedClientsByTargetId] = useState<
    Record<string, RemoteWorkspaceConnectedClient[]>
  >({})

  useEffect(() => {
    const targetIds = presenceTargetIdsKey ? presenceTargetIdsKey.split('\n') : []
    if (targetIds.length === 0) {
      setConnectedClientsByTargetId({})
      return
    }
    const unavailableClientsByTargetId = Object.fromEntries(targetIds.map((id) => [id, []]))
    if (!window.api.remoteWorkspace?.listConnectedClients) {
      setConnectedClientsByTargetId(unavailableClientsByTargetId)
      return
    }

    let cancelled = false
    const loadConnectedClients = async (): Promise<void> => {
      try {
        const results = await window.api.remoteWorkspace.listConnectedClients({ targetIds })
        if (cancelled) {
          return
        }
        setConnectedClientsByTargetId(
          Object.fromEntries(results.map((entry) => [entry.targetId, entry.clients]))
        )
      } catch {
        if (!cancelled) {
          setConnectedClientsByTargetId(unavailableClientsByTargetId)
        }
      }
    }

    void loadConnectedClients()
    const interval = window.setInterval(() => void loadConnectedClients(), DEVICE_PRESENCE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [presenceTargetIdsKey])

  return connectedClientsByTargetId
}
