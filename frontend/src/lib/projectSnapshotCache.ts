// In-memory, app-session-scoped LRU cache of a project's UI state.
//
// Switching to a project that was visited earlier in the SAME app session is
// meant to feel instant: `performSwitch` rehydrates this snapshot synchronously
// (file tree + git status + session list + active session) right after the
// `switchProject` RPC settles, then lets the existing asynchronous reload path
// reconcile with fresh backend data and overwrite the hydrated values (see
// `useProjectSwitchState`).
//
// Deliberately a plain module-level store, NOT a Zustand store: the snapshot is
// cross-project by nature, applies only inside the switch flow, and must not
// trigger React renders of its own. The captured references are read from the
// project stores at `capture` time — the stores replace state immutably, so a
// shallow copy of the top-level containers is enough to freeze a point in time.
//
// Capacity is small (three projects) so switching between the two or three
// projects a user actually works with stays instant without unbounded growth.

import type { SessionInfo } from '@/types/models'
import { useFileTreeStore, type FileTreeSnapshot } from '@/stores/fileTreeStore'
import { useSessionStore } from '@/stores/sessionStore'

// The file-tree slice (`FileTreeSnapshot`) is defined next to its only
// consumer, `fileTreeStore.restoreFromSnapshot`; re-exported here so callers
// can treat the snapshot as one unit.
export type { FileTreeSnapshot }

/** A point-in-time snapshot of one project's frontend UI state. */
export interface ProjectSnapshot extends FileTreeSnapshot {
  /** The project's session list at capture time, or null when it had not been
   *  loaded yet (the caller then falls through to the async reload path). */
  sessions: SessionInfo[] | null
  activeSessionId: string | null
  /** Epoch millis of capture — diagnostics / test assertions only. */
  savedAt: number
}

/** Maximum number of cached projects; the least-recently-used is evicted. */
export const MAX_SNAPSHOTS = 3

// Insertion order IS the recency order: the first key is the LRU entry. A
// restore re-inserts its key at the end (see `restore`), so eviction always
// drops the project that has gone the longest without being used or revisited.
const snapshots = new Map<string, ProjectSnapshot>()

/**
 * Capture the current UI state of `projectId` from the project stores.
 * Overwrites any earlier snapshot for the same project and evicts the
 * least-recently-used entry beyond `MAX_SNAPSHOTS`. No-op for an empty id.
 */
export function capture(projectId: string): void {
  if (!projectId) return

  const tree = useFileTreeStore.getState()
  const session = useSessionStore.getState()

  const snapshot: ProjectSnapshot = {
    // Shallow-copy the top-level containers so a later store update (which
    // always replaces containers immutably) can never mutate the snapshot.
    rootPath: tree.rootPath,
    tree: { ...tree.tree },
    expandedDirs: { ...tree.expandedDirs },
    gitStatus: { ...tree.gitStatus },
    sessions: session.sessions ? [...session.sessions] : null,
    activeSessionId: session.activeSessionId,
    savedAt: Date.now(),
  }

  // delete+set moves an existing key to the end (most-recently-used) and
  // appends a new one.
  snapshots.delete(projectId)
  snapshots.set(projectId, snapshot)

  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value
    if (oldest === undefined) break
    snapshots.delete(oldest)
  }
}

/**
 * Look up the snapshot for `projectId`. A hit marks the project as
 * most-recently-used and returns the snapshot; a miss returns null.
 */
export function restore(projectId: string): ProjectSnapshot | null {
  const snapshot = snapshots.get(projectId)
  if (!snapshot) return null
  // Refresh recency so a revisited project is not the next eviction victim.
  snapshots.delete(projectId)
  snapshots.set(projectId, snapshot)
  return snapshot
}

/** Drop a single project's snapshot (e.g. when the project is deleted). */
export function drop(projectId: string): void {
  snapshots.delete(projectId)
}

/** Drop every snapshot (test isolation / hard reset). */
export function clear(): void {
  snapshots.clear()
}

/** Number of cached snapshots. Test-facing; avoids exposing the Map itself. */
export function size(): number {
  return snapshots.size
}

/** Whether `projectId` currently has a cached snapshot. Test-facing. */
export function has(projectId: string): boolean {
  return snapshots.has(projectId)
}
