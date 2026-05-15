import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { TerminalTab } from '../../../../shared/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'

// Why: stable empty-array references so narrow selectors return the same
// reference when there's nothing for this worktree. Without stable empties,
// zustand's shallow equality would see a new `[]` every render and trigger
// unnecessary re-renders — defeating the purpose of the narrow selector.
const EMPTY_TABS: TerminalTab[] = []
const EMPTY_LIVE_ENTRIES: AgentStatusEntry[] = []
const EMPTY_RETAINED: RetainedAgentEntry[] = []

type WorktreeAgentRowsState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
>

type LiveEntriesCacheEntry = {
  tabs: TerminalTab[]
  agentStatusByPaneKey: WorktreeAgentRowsState['agentStatusByPaneKey']
  migrationUnsupportedByPtyId: WorktreeAgentRowsState['migrationUnsupportedByPtyId']
  entries: AgentStatusEntry[]
}

type RetainedCacheEntry = {
  retainedAgentsByPaneKey: WorktreeAgentRowsState['retainedAgentsByPaneKey']
  retained: RetainedAgentEntry[]
}

const liveEntriesCacheByWorktree = new Map<string, LiveEntriesCacheEntry>()
const retainedCacheByWorktree = new Map<string, RetainedCacheEntry>()

export function selectWorktreeLiveEntries(
  state: WorktreeAgentRowsState,
  worktreeId: string
): AgentStatusEntry[] {
  const wtTabs = state.tabsByWorktree[worktreeId] ?? EMPTY_TABS
  const cached = liveEntriesCacheByWorktree.get(worktreeId)
  if (
    cached &&
    cached.tabs === wtTabs &&
    cached.agentStatusByPaneKey === state.agentStatusByPaneKey &&
    cached.migrationUnsupportedByPtyId === state.migrationUnsupportedByPtyId
  ) {
    return cached.entries
  }

  if (wtTabs.length === 0) {
    liveEntriesCacheByWorktree.set(worktreeId, {
      tabs: wtTabs,
      agentStatusByPaneKey: state.agentStatusByPaneKey,
      migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
      entries: EMPTY_LIVE_ENTRIES
    })
    return EMPTY_LIVE_ENTRIES
  }

  const tabIds = new Set(wtTabs.map((t) => t.id))
  const out: AgentStatusEntry[] = []
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    const parsed = parsePaneKey(paneKey)
    if (!parsed) {
      continue
    }
    if (!tabIds.has(parsed.tabId)) {
      continue
    }
    out.push(entry)
  }
  for (const unsupported of Object.values(state.migrationUnsupportedByPtyId)) {
    const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
    if (!entry) {
      continue
    }
    const parsed = parsePaneKey(entry.paneKey)
    if (!parsed || !tabIds.has(parsed.tabId)) {
      continue
    }
    out.push(entry)
  }

  const entries = out.length > 0 ? out : EMPTY_LIVE_ENTRIES
  liveEntriesCacheByWorktree.set(worktreeId, {
    tabs: wtTabs,
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
    entries
  })
  return entries
}

export function selectWorktreeRetainedAgents(
  state: WorktreeAgentRowsState,
  worktreeId: string
): RetainedAgentEntry[] {
  const cached = retainedCacheByWorktree.get(worktreeId)
  if (cached && cached.retainedAgentsByPaneKey === state.retainedAgentsByPaneKey) {
    return cached.retained
  }

  const out: RetainedAgentEntry[] = []
  for (const ra of Object.values(state.retainedAgentsByPaneKey)) {
    if (ra.worktreeId === worktreeId) {
      out.push(ra)
    }
  }

  const retained = out.length > 0 ? out : EMPTY_RETAINED
  retainedCacheByWorktree.set(worktreeId, {
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
    retained
  })
  return retained
}

export function buildWorktreeAgentRows(args: {
  tabs: TerminalTab[]
  entries: AgentStatusEntry[]
  retained: RetainedAgentEntry[]
  now: number
}): DashboardAgentRow[] {
  const rows: DashboardAgentRow[] = []
  const seenPaneKeys = new Set<string>()

  const entriesByTabId = new Map<string, AgentStatusEntry[]>()
  for (const entry of args.entries) {
    const parsed = parsePaneKey(entry.paneKey)
    if (!parsed) {
      continue
    }
    const bucket = entriesByTabId.get(parsed.tabId)
    if (bucket) {
      bucket.push(entry)
    } else {
      entriesByTabId.set(parsed.tabId, [entry])
    }
  }

  for (const tab of args.tabs) {
    const explicitEntries = entriesByTabId.get(tab.id) ?? []
    for (const entry of explicitEntries) {
      const isFresh = isExplicitAgentStatusFresh(entry, args.now, AGENT_STATUS_STALE_AFTER_MS)
      const shouldDecay =
        !isFresh &&
        (entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting')
      rows.push({
        paneKey: entry.paneKey,
        entry,
        tab,
        agentType: entry.agentType ?? 'unknown',
        state: shouldDecay ? 'idle' : entry.state,
        startedAt: entry.stateHistory[0]?.startedAt ?? entry.stateStartedAt
      })
      seenPaneKeys.add(entry.paneKey)
    }
  }

  for (const ra of args.retained) {
    if (seenPaneKeys.has(ra.entry.paneKey)) {
      continue
    }
    rows.push({
      paneKey: ra.entry.paneKey,
      entry: ra.entry,
      tab: ra.tab,
      agentType: ra.agentType,
      state: 'done',
      startedAt: ra.startedAt
    })
  }

  rows.sort((a, b) => a.startedAt - b.startedAt)
  return rows
}

/**
 * Narrow per-worktree agent row hook used by the WorktreeCard inline agents
 * list. Produces live hook-reported agents plus retained "done" snapshots,
 * stale-decayed to 'idle' when the hook stream has gone quiet.
 *
 * Uses per-worktree selectors rather than reusing useDashboardData's
 * cross-worktree aggregate — that pipeline is O(repos × worktrees × agents)
 * and would recompute once per sidebar card on every agent-status event.
 * Scoped selectors keep the cost O(this-worktree-entries) per card.
 */
export function useWorktreeAgentRows(worktreeId: string): DashboardAgentRow[] {
  const tabs = useAppStore((s) => s.tabsByWorktree[worktreeId] ?? EMPTY_TABS)
  // Why: narrow the subscriptions to only THIS worktree's entries via
  // useShallow. Subscribing to the whole agentStatusByPaneKey map would make
  // every on-screen card re-render on any agent-status update anywhere —
  // O(worktrees²) render amplification. Pre-filtering here means the card
  // only re-renders when something relevant to THIS worktree changes. The
  // selectors cache by store-map identity because React calls getSnapshot more
  // than once per render; returning a fresh non-empty array there can crash.
  const entries = useAppStore(useShallow((s) => selectWorktreeLiveEntries(s, worktreeId)))
  const retained = useAppStore(useShallow((s) => selectWorktreeRetainedAgents(s, worktreeId)))
  // Why: agentStatusEpoch is included in the dependency array (but not in the
  // computation itself) so the memo recomputes when freshness boundaries
  // expire, even if no new PTY data arrives — same rationale as
  // useDashboardData.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)

  return useMemo<DashboardAgentRow[]>(() => {
    // Why: Date.now() is read inside the memo (not as a dep) so stale-decay
    // recalculates whenever agentStatusEpoch ticks — same pattern as
    // useDashboardData.
    return buildWorktreeAgentRows({
      tabs,
      entries,
      retained,
      now: Date.now()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, entries, retained, agentStatusEpoch])
}
