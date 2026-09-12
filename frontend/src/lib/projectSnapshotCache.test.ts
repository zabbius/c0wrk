import { describe, it, expect, beforeEach } from 'vitest'
import * as cache from '@/lib/projectSnapshotCache'
import { useFileTreeStore } from '@/stores/fileTreeStore'
import { useSessionStore } from '@/stores/sessionStore'
import type { FileEntry, GitStatusEntry, SessionInfo } from '@/types/models'

function makeEntry(path: string, isDir = false): FileEntry {
  return {
    name: path.split('/').pop() ?? path,
    path,
    is_dir: isDir,
    hidden: false,
    gitignored: false,
    icon: '',
    icon_color: '',
  }
}

function makeSession(id: string, projectId: string): SessionInfo {
  return {
    id,
    project_id: projectId,
    name: `Session ${id}`,
    created_at: '2026-01-01T00:00:00Z',
    last_active_at: '2026-01-01T00:00:00Z',
    archived: false,
    pinned: false,
    active: false,
    total_input_tokens: 0,
    total_output_tokens: 0,
    model: '',
    family: '',
    has_unfinished_task: false,
    unfinished_task_status: '',
  }
}

/** Seed the stores with a minimally-identifiable tree rooted at `rootPath`,
 *  then capture it under `projectId`. */
function seedAndCapture(projectId: string, rootPath = `/${projectId}`): void {
  useFileTreeStore.setState({ rootPath })
  cache.capture(projectId)
}

describe('projectSnapshotCache', () => {
  beforeEach(() => {
    cache.clear()
    useFileTreeStore.getState().clearTree()
    useSessionStore.setState({ sessions: null, activeSessionId: null })
  })

  it('round-trips a captured snapshot (tree, expanded dirs, git status, sessions)', () => {
    const git = {
      '/p1/a.ts': { status: 'M', staged: false, index_status: '', worktree_status: 'M' } as GitStatusEntry,
    }
    useFileTreeStore.setState({
      rootPath: '/p1',
      tree: { '/p1': [makeEntry('/p1/a.ts')], '/p1/src': [makeEntry('/p1/src/b.ts')] },
      expandedDirs: { '/p1/src': true },
      gitStatus: git,
    })
    useSessionStore.setState({
      sessions: [makeSession('s1', 'p1'), makeSession('s2', 'p1')],
      activeSessionId: 's1',
    })

    cache.capture('p1')

    // Mutate the live stores — the snapshot must be frozen in time.
    useFileTreeStore.getState().clearTree()
    useSessionStore.setState({ sessions: null, activeSessionId: null })

    const snapshot = cache.restore('p1')
    expect(snapshot).not.toBeNull()
    expect(snapshot!.rootPath).toBe('/p1')
    expect(snapshot!.tree).toEqual({
      '/p1': [makeEntry('/p1/a.ts')],
      '/p1/src': [makeEntry('/p1/src/b.ts')],
    })
    expect(snapshot!.expandedDirs).toEqual({ '/p1/src': true })
    expect(snapshot!.gitStatus).toEqual(git)
    expect(snapshot!.sessions?.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(snapshot!.activeSessionId).toBe('s1')
    expect(typeof snapshot!.savedAt).toBe('number')
  })

  it('returns null for a project that was never captured', () => {
    expect(cache.restore('nope')).toBeNull()
    expect(cache.has('nope')).toBe(false)
  })

  it('LRU(3): a fourth captured project evicts the least-recently-used', () => {
    seedAndCapture('p1')
    seedAndCapture('p2')
    seedAndCapture('p3')
    expect(cache.size()).toBe(3)

    seedAndCapture('p4')

    expect(cache.size()).toBe(3)
    expect(cache.has('p1')).toBe(false)
    expect(cache.has('p2')).toBe(true)
    expect(cache.has('p3')).toBe(true)
    expect(cache.has('p4')).toBe(true)
  })

  it('restore refreshes recency so a revisited project survives eviction', () => {
    seedAndCapture('p1')
    seedAndCapture('p2')
    seedAndCapture('p3')

    // Touch p1 — it becomes the most-recently-used, so p2 is now the LRU.
    expect(cache.restore('p1')).not.toBeNull()

    seedAndCapture('p4')

    expect(cache.has('p1')).toBe(true)
    expect(cache.has('p2')).toBe(false)
    expect(cache.size()).toBe(3)
  })

  it('drop removes a single project snapshot and leaves the others intact', () => {
    seedAndCapture('p1')
    seedAndCapture('p2')

    cache.drop('p1')

    expect(cache.has('p1')).toBe(false)
    expect(cache.restore('p1')).toBeNull()
    expect(cache.has('p2')).toBe(true)
    expect(cache.size()).toBe(1)
  })

  it('capture ignores an empty project id', () => {
    cache.capture('')
    expect(cache.size()).toBe(0)
  })

  it('re-capturing the same project overwrites the previous snapshot', () => {
    seedAndCapture('p1', '/p1')
    seedAndCapture('p1', '/p1-v2')

    expect(cache.size()).toBe(1)
    expect(cache.restore('p1')!.rootPath).toBe('/p1-v2')
  })

  it('clear drops every snapshot', () => {
    seedAndCapture('p1')
    seedAndCapture('p2')
    cache.clear()
    expect(cache.size()).toBe(0)
  })
})
