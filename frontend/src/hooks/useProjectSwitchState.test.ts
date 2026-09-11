// jsdom environment: this file imports fileViewerStore, whose zustand persist
// middleware resolves the default `createJSONStorage(() => window.localStorage)`
// at import time. Without `window` (plain node env) the middleware degrades to
// "storage unavailable" and warns on every `set` (see panelPersistence.test.ts
// for the same jsdom opt-in).
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileViewerStore } from '@/stores/fileViewerStore'
import { useFileTreeStore } from '@/stores/fileTreeStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import * as projectSnapshotCache from '@/lib/projectSnapshotCache'
import type { FileEntry, ProjectSwitchState, SessionInfo } from '@/types/models'

const mocks = vi.hoisted(() => ({
  saveProjectSwitchStateMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  switchProjectMock: vi.fn<(id: string) => Promise<void>>(),
  getProjectSwitchStateMock: vi.fn<(...args: unknown[]) => Promise<ProjectSwitchState | null>>(),
  listSessionsMock: vi.fn<(...args: unknown[]) => Promise<SessionInfo[]>>(),
  createSessionMock: vi.fn<(...args: unknown[]) => Promise<SessionInfo>>(),
}))

vi.mock('react', () => ({
  useCallback: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}))

vi.mock('@/api/projects', () => ({
  saveProjectSwitchState: mocks.saveProjectSwitchStateMock,
  switchProject: mocks.switchProjectMock,
  getProjectSwitchState: mocks.getProjectSwitchStateMock,
}))

vi.mock('@/api/sessions', () => ({
  listSessions: mocks.listSessionsMock,
  createSession: mocks.createSessionMock,
}))

// The watchdog tests below deliberately stall a switch past its timeout;
// without the mock, logger.warn writes the expected watchdog/supersede
// notices to the real console and pollutes the test output.
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

function makeSession(overrides: Partial<SessionInfo> & { id: string; project_id: string }): SessionInfo {
  return {
    id: overrides.id,
    project_id: overrides.project_id,
    name: overrides.name ?? `Session ${overrides.id}`,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    last_active_at: overrides.last_active_at ?? '2026-01-01T00:00:00Z',
    archived: overrides.archived ?? false,
    pinned: overrides.pinned ?? false,
    active: overrides.active ?? false,
    total_input_tokens: overrides.total_input_tokens ?? 0,
    total_output_tokens: overrides.total_output_tokens ?? 0,
    model: overrides.model ?? '',
    family: overrides.family ?? '',
    has_unfinished_task: overrides.has_unfinished_task ?? false,
    unfinished_task_status: overrides.unfinished_task_status ?? '',
  }
}

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

function resetStores() {
  useProjectStore.setState({ projects: null, activeProjectId: null })
  useSessionStore.setState({ sessions: null, activeSessionId: null })
  useFileTreeStore.getState().clearTree()
  // The snapshot cache is a module-level singleton: clear it between tests so
  // a snapshot captured by one test cannot be hydrated by the next.
  projectSnapshotCache.clear()
  useFileViewerStore.setState({
    files: {},
    openTabs: [],
    activeFile: null,
    width: 500,
    collapsed: false,
    highlightLine: null,
    fileIcons: {},
  })
}

describe('useProjectSwitchState', () => {
  beforeEach(() => {
    resetStores()
    mocks.saveProjectSwitchStateMock.mockReset()
    mocks.switchProjectMock.mockReset()
    mocks.getProjectSwitchStateMock.mockReset()
    mocks.listSessionsMock.mockReset()
    mocks.createSessionMock.mockReset()

    mocks.saveProjectSwitchStateMock.mockResolvedValue(undefined)
    mocks.switchProjectMock.mockResolvedValue(undefined)
    mocks.getProjectSwitchStateMock.mockResolvedValue(null)
    mocks.listSessionsMock.mockResolvedValue([])
    mocks.createSessionMock.mockResolvedValue(makeSession({
      id: 'created-1',
      project_id: 'target-project',
      last_active_at: '2026-02-01T00:00:00Z',
    }))
  })

  it('saves source project state before switching and restores destination open files + saved session', async () => {
    useProjectStore.getState().setActiveProjectId('source-project')
    useSessionStore.getState().setActiveSessionId('source-session')
    useFileViewerStore.getState().restoreProjectFiles(['src/a.ts', 'src/b.ts'], 'src/b.ts')
    useFileViewerStore.getState().setCollapsed(true)

    mocks.getProjectSwitchStateMock.mockResolvedValue({
      project_id: 'target-project',
      saved_session_id: 'target-saved-session',
      open_tabs: ['dest/readme.md', 'dest/main.go'],
      active_file: 'dest/main.go',
      updated_at: '2026-03-01T00:00:00Z',
    })

    mocks.listSessionsMock.mockResolvedValue([
      makeSession({ id: 'target-saved-session', project_id: 'target-project', last_active_at: '2026-03-01T00:00:00Z' }),
      makeSession({ id: 'other-session', project_id: 'target-project', last_active_at: '2026-02-01T00:00:00Z' }),
    ])

    const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
    const runSwitch = useProjectSwitchState()
    await runSwitch('target-project')

    expect(mocks.saveProjectSwitchStateMock).toHaveBeenCalledTimes(1)
    expect(mocks.saveProjectSwitchStateMock).toHaveBeenCalledWith({
      project_id: 'source-project',
      open_tabs: ['src/a.ts', 'src/b.ts'],
      active_file: 'src/b.ts',
      saved_session_id: 'source-session',
    })

    expect(mocks.switchProjectMock).toHaveBeenCalledWith('target-project')
    expect(mocks.getProjectSwitchStateMock).toHaveBeenCalledWith('target-project')

    const fileState = useFileViewerStore.getState()
    expect(fileState.openTabs).toEqual(['dest/readme.md', 'dest/main.go'])
    expect(fileState.activeFile).toBe('dest/main.go')
    expect(fileState.collapsed).toBe(true)

    const sessionState = useSessionStore.getState()
    expect(sessionState.activeSessionId).toBe('target-saved-session')
    expect(sessionState.sessions?.map((s) => s.id)).toEqual(['target-saved-session', 'other-session'])
    expect(mocks.createSessionMock).not.toHaveBeenCalled()
    expect(useProjectStore.getState().activeProjectId).toBe('target-project')
  })

  it('falls back to latest session when saved session is absent from destination list', async () => {
    useProjectStore.getState().setActiveProjectId('source-project')

    mocks.getProjectSwitchStateMock.mockResolvedValue({
      project_id: 'target-project',
      saved_session_id: 'missing-saved-session',
      open_tabs: ['dest/one.ts'],
      active_file: 'dest/one.ts',
      updated_at: '2026-03-02T00:00:00Z',
    })

    mocks.listSessionsMock.mockResolvedValue([
      makeSession({ id: 'older-session', project_id: 'target-project', last_active_at: '2026-01-01T00:00:00Z' }),
      makeSession({ id: 'latest-session', project_id: 'target-project', last_active_at: '2026-06-01T10:00:00Z' }),
    ])

    const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
    const runSwitch = useProjectSwitchState()
    await runSwitch('target-project')

    expect(useSessionStore.getState().activeSessionId).toBe('latest-session')
    expect(mocks.createSessionMock).not.toHaveBeenCalled()
  })

  it('creates a new session when destination project has no sessions', async () => {
    useProjectStore.getState().setActiveProjectId('source-project')

    mocks.getProjectSwitchStateMock.mockResolvedValue({
      project_id: 'target-project',
      saved_session_id: '',
      open_tabs: ['dest/new.ts'],
      active_file: 'dest/new.ts',
      updated_at: '2026-03-03T00:00:00Z',
    })
    mocks.listSessionsMock.mockResolvedValue([])
    mocks.createSessionMock.mockResolvedValue(makeSession({
      id: 'created-session',
      project_id: 'target-project',
      last_active_at: '2026-03-03T01:00:00Z',
    }))

    const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
    const runSwitch = useProjectSwitchState()
    await runSwitch('target-project')

    expect(mocks.createSessionMock).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().activeSessionId).toBe('created-session')
    expect(useSessionStore.getState().sessions?.map((s) => s.id)).toContain('created-session')
  })

  it('restores the saved session even when other sessions have fresher activity', async () => {
    // The saved session id is persisted on every explicit selection
    // (selectSession → saveProjectActiveSession) and on switch-away, so it is
    // authoritative: the user explicitly chose this session. Latest-by-activity
    // is only the fallback for a missing or archived saved entry.
    useProjectStore.getState().setActiveProjectId('old-project')

    mocks.getProjectSwitchStateMock.mockResolvedValue({
      project_id: 'target-project',
      saved_session_id: 'saved-session',
      open_tabs: ['dest/stale.ts'],
      active_file: 'dest/stale.ts',
      updated_at: '2026-03-01T00:00:00Z',
    })

    mocks.listSessionsMock.mockResolvedValue([
      makeSession({ id: 'session-1', project_id: 'target-project', last_active_at: '2026-03-05T00:00:00Z' }),
      makeSession({ id: 'session-2', project_id: 'target-project', last_active_at: '2026-03-04T00:00:00Z' }),
      makeSession({ id: 'session-3', project_id: 'target-project', last_active_at: '2026-03-03T00:00:00Z' }),
      makeSession({ id: 'saved-session', project_id: 'target-project', last_active_at: '2026-03-02T00:00:00Z' }),
      makeSession({ id: 'session-5', project_id: 'target-project', last_active_at: '2026-03-01T00:00:00Z' }),
    ])

    const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
    const runSwitch = useProjectSwitchState()
    await runSwitch('target-project')

    // Must restore the explicitly saved session, NOT the freshest one.
    const sessionState = useSessionStore.getState()
    expect(sessionState.activeSessionId).toBe('saved-session')
    expect(mocks.createSessionMock).not.toHaveBeenCalled()
  })

  it('falls back to the latest non-archived session when the saved session is archived', async () => {
    useProjectStore.getState().setActiveProjectId('source-project')

    mocks.getProjectSwitchStateMock.mockResolvedValue({
      project_id: 'target-project',
      saved_session_id: 'archived-saved-session',
      open_tabs: [],
      active_file: '',
      updated_at: '2026-03-02T00:00:00Z',
    })

    mocks.listSessionsMock.mockResolvedValue([
      makeSession({ id: 'archived-saved-session', project_id: 'target-project', archived: true, last_active_at: '2026-06-01T10:00:00Z' }),
      makeSession({ id: 'older-session', project_id: 'target-project', last_active_at: '2026-01-01T00:00:00Z' }),
      makeSession({ id: 'latest-session', project_id: 'target-project', last_active_at: '2026-03-01T00:00:00Z' }),
    ])

    const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
    const runSwitch = useProjectSwitchState()
    await runSwitch('target-project')

    expect(useSessionStore.getState().activeSessionId).toBe('latest-session')
    expect(mocks.createSessionMock).not.toHaveBeenCalled()
  })

  it('never restores an archived session even with the freshest activity', async () => {
    useProjectStore.getState().setActiveProjectId('source-project')

    mocks.getProjectSwitchStateMock.mockResolvedValue({
      project_id: 'target-project',
      saved_session_id: '',
      open_tabs: [],
      active_file: '',
      updated_at: '2026-03-02T00:00:00Z',
    })

    mocks.listSessionsMock.mockResolvedValue([
      makeSession({ id: 'archived-freshest', project_id: 'target-project', archived: true, last_active_at: '2026-06-01T10:00:00Z' }),
      makeSession({ id: 'active-older', project_id: 'target-project', last_active_at: '2026-01-01T00:00:00Z' }),
    ])

    const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
    const runSwitch = useProjectSwitchState()
    await runSwitch('target-project')

    expect(useSessionStore.getState().activeSessionId).toBe('active-older')
    expect(mocks.createSessionMock).not.toHaveBeenCalled()
  })

  it('creates a new session when only archived sessions remain', async () => {
    useProjectStore.getState().setActiveProjectId('source-project')

    mocks.getProjectSwitchStateMock.mockResolvedValue({
      project_id: 'target-project',
      saved_session_id: 'archived-saved-session',
      open_tabs: [],
      active_file: '',
      updated_at: '2026-03-03T00:00:00Z',
    })
    mocks.listSessionsMock.mockResolvedValue([
      makeSession({ id: 'archived-saved-session', project_id: 'target-project', archived: true, last_active_at: '2026-06-01T10:00:00Z' }),
      makeSession({ id: 'archived-other', project_id: 'target-project', archived: true, last_active_at: '2026-05-01T00:00:00Z' }),
    ])
    mocks.createSessionMock.mockResolvedValue(makeSession({
      id: 'created-session',
      project_id: 'target-project',
      last_active_at: '2026-03-03T01:00:00Z',
    }))

    const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
    const runSwitch = useProjectSwitchState()
    await runSwitch('target-project')

    expect(mocks.createSessionMock).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().activeSessionId).toBe('created-session')
  })

  it('does not restore stale backend open tabs on initial (startup) activation', async () => {
    // Reproduces the persistence bug: on app startup loadAndActivate calls
    // switchProjectWithState with NO previously active project. The backend
    // per-project switch state is stale on restart (it is only persisted when
    // switching *away* from a project), so it may still reference tabs the
    // user dismissed — e.g. a plan that was opened then closed. The file-viewer
    // store was already rehydrated from localStorage with the tabs that were
    // actually open at shutdown; the backend tabs must NOT overwrite them.
    useProjectStore.setState({ projects: null, activeProjectId: null })

    // Simulate the localStorage-rehydrated state: user had a single source
    // file open and the plan was already closed (not present here).
    useFileViewerStore.setState({
      files: { 'src/main.ts': { content: '', loading: true } },
      openTabs: ['src/main.ts'],
      activeFile: 'src/main.ts',
    })

    // Backend still has the stale snapshot from days ago, including the plan.
    mocks.getProjectSwitchStateMock.mockResolvedValue({
      project_id: 'target-project',
      saved_session_id: '',
      open_tabs: ['src/main.ts', 'plans/old-plan.md'],
      active_file: 'plans/old-plan.md',
      updated_at: '2026-03-01T00:00:00Z',
    })

    mocks.listSessionsMock.mockResolvedValue([
      makeSession({ id: 'latest-session', project_id: 'target-project', last_active_at: '2026-06-01T10:00:00Z' }),
    ])

    const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
    const runSwitch = useProjectSwitchState()
    await runSwitch('target-project')

    // The localStorage-rehydrated tabs must be preserved untouched — the stale
    // backend plan must NOT be reopened.
    const fileState = useFileViewerStore.getState()
    expect(fileState.openTabs).toEqual(['src/main.ts'])
    expect(fileState.activeFile).toBe('src/main.ts')
    // No source project to save on initial activation.
    expect(mocks.saveProjectSwitchStateMock).not.toHaveBeenCalled()
  })

  it('serializes concurrent switches so a rapid CHAT↔CODE toggle cannot interleave store writes', async () => {
    // Regression: two in-flight switches used to interleave their store
    // writes (activeSessionId picked from another project's listSessions
    // snapshot, activeProjectId landing out of order), leaving the file-tree
    // rootPath outside the backend's active project. ListDirectory then
    // rejected that root on every call and @-file completions in the chat
    // input stayed empty until an app restart.
    useProjectStore.setState({ activeProjectId: 'p1' })

    const rpcOrder: string[] = []
    mocks.switchProjectMock.mockImplementation(async (id: string) => {
      rpcOrder.push(id)
    })

    // The first switch stalls at getProjectSwitchState (deferred gate).
    // Typed as the mock's value type so mockImplementationOnce accepts it;
    // releasing resolves null = "no saved state", the same falsy-saved path
    // the previous void gate produced.
    let releaseFirst: (() => void) | undefined
    const gate = new Promise<ProjectSwitchState | null>((resolve) => {
      releaseFirst = () => resolve(null)
    })
    mocks.getProjectSwitchStateMock.mockImplementationOnce(() => gate)

    const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
    const runSwitch = useProjectSwitchState()

    const first = runSwitch('p2')
    const second = runSwitch('p3')

    // Let microtasks settle: the second switch must NOT have reached its
    // switchProject RPC while the first is still mid-flight.
    await Promise.resolve()
    await Promise.resolve()
    expect(rpcOrder).toEqual(['p2'])

    releaseFirst?.()
    await first
    await second

    expect(rpcOrder).toEqual(['p2', 'p3'])
    expect(useProjectStore.getState().activeProjectId).toBe('p3')
  })

  it('discards the late writes of a watchdog-released switch instead of reverting the newer switch', async () => {
    vi.useFakeTimers()
    try {
      useProjectStore.setState({ activeProjectId: 'p0' })

      // Switch 1 stalls at its switchProject RPC (deferred, resolved
      // manually after the watchdog has already released the queue).
      let releaseStalled: (() => void) | undefined
      const stalled = new Promise<void>((resolve) => {
        releaseStalled = resolve
      })
      mocks.switchProjectMock.mockImplementation((id: string) =>
        id === 'p1-stalled' ? stalled : Promise.resolve(),
      )

      const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
      const runSwitch = useProjectSwitchState()

      const first = runSwitch('p1-stalled')
      void first.catch(() => { /* watchdog rejection is asserted below */ })
      // Flush microtasks so switch 1 reaches its stalled RPC.
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.switchProjectMock).toHaveBeenCalledWith('p1-stalled')

      // A newer switch is requested while switch 1 is still stalled.
      const second = runSwitch('p2-fresh')
      // The 30s watchdog fires, releases the queue, and switch 2 completes.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(useProjectStore.getState().activeProjectId).toBe('p2-fresh')
      const sessionsAfterSecond = useSessionStore.getState().sessions

      // The stalled RPC finally settles — switch 1's body resumes.
      releaseStalled?.()
      await stalled
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      // Switch 1's remaining store writes are DISCARDED (seq guard). Without
      // the guard the late body reverts activeProjectId to p1-stalled while
      // the backend is on p2-fresh — a desync under which ListDirectory
      // persistently rejects the frontend's rootPath and @-completions stay
      // empty until an app restart.
      expect(useProjectStore.getState().activeProjectId).toBe('p2-fresh')
      expect(useSessionStore.getState().sessions).toBe(sessionsAfterSecond)
      await expect(first).rejects.toThrow(/timed out/)
      await second
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards a stale session list resolved after a newer switch began', async () => {
    // Regression: setSessions used to run immediately when the listSessions
    // RPC resolved, BEFORE the supersede guard — a stalled list that settled
    // after a newer switch clobbered the newer switch's session list while
    // activeProjectId pointed into the new project.
    vi.useFakeTimers()
    try {
      useProjectStore.setState({ activeProjectId: 'p0' })

      // Switch 1 stalls at its listSessions RPC.
      let releaseStalled: (() => void) | undefined
      const stalled = new Promise<SessionInfo[]>((resolve) => {
        releaseStalled = () => resolve([])
      })
      mocks.switchProjectMock.mockResolvedValue(undefined)
      // First call (switch 1) gets the stalled promise; later calls resolve.
      let firstCall = true
      mocks.listSessionsMock.mockImplementation(() => {
        if (firstCall) {
          firstCall = false
          return stalled
        }
        return Promise.resolve([])
      })

      const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
      const runSwitch = useProjectSwitchState()

      const first = runSwitch('p1-stalled')
      void first.catch(() => { /* watchdog rejection asserted below */ })
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.switchProjectMock).toHaveBeenCalledWith('p1-stalled')

      const second = runSwitch('p2-fresh')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(useProjectStore.getState().activeProjectId).toBe('p2-fresh')
      const sessionsAfterSecond = useSessionStore.getState().sessions

      // The stalled session list settles AFTER the newer switch completed:
      // the stale list must never land in the store.
      releaseStalled?.()
      await stalled
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      expect(useSessionStore.getState().sessions).toBe(sessionsAfterSecond)
      await expect(first).rejects.toThrow(/timed out/)
      await second
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconcile path: a click on the already-active project sends one switch RPC and skips the session teardown', async () => {
    // Invariant: the active-project click is NOT short-circuited locally — the
    // idempotent backend RPC still runs so it can re-emit project:switched and
    // repair a frontend↔backend desync without an app restart. The heavy
    // teardown must NOT run, though: no resetForProjectSwitch / listSessions
    // reload (that would flash the UI — sessions briefly null).
    useProjectStore.setState({ activeProjectId: 'p1' })
    const existingSessions = [makeSession({ id: 's1', project_id: 'p1' })]
    useSessionStore.setState({ sessions: existingSessions, activeSessionId: 's1' })

    const resetSpy = vi.spyOn(useSessionStore.getState(), 'resetForProjectSwitch')
    const setSessionsSpy = vi.spyOn(useSessionStore.getState(), 'setSessions')
    try {
      const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
      const runSwitch = useProjectSwitchState()
      await runSwitch('p1')

      // Exactly one switch RPC reaches the backend...
      expect(mocks.switchProjectMock).toHaveBeenCalledTimes(1)
      expect(mocks.switchProjectMock).toHaveBeenCalledWith('p1')
      // ...and none of the real-switch teardown runs.
      expect(mocks.saveProjectSwitchStateMock).not.toHaveBeenCalled()
      expect(resetSpy).not.toHaveBeenCalled()
      expect(setSessionsSpy).not.toHaveBeenCalled()
      expect(mocks.listSessionsMock).not.toHaveBeenCalled()
      expect(mocks.getProjectSwitchStateMock).not.toHaveBeenCalled()
      expect(mocks.createSessionMock).not.toHaveBeenCalled()
      // The stores are left exactly as they were (no UI flash).
      expect(useProjectStore.getState().activeProjectId).toBe('p1')
      expect(useSessionStore.getState().sessions).toBe(existingSessions)
      expect(useSessionStore.getState().activeSessionId).toBe('s1')
    } finally {
      resetSpy.mockRestore()
      setSessionsSpy.mockRestore()
    }
  })

  it('reconcile path: a body superseded while its switch RPC is in flight does not write to the stores', async () => {
    vi.useFakeTimers()
    try {
      useProjectStore.setState({ activeProjectId: 'p1' })

      // The reconcile switch's idempotent RPC stalls.
      let releaseStalled: (() => void) | undefined
      const stalled = new Promise<void>((resolve) => {
        releaseStalled = () => resolve()
      })
      let firstCall = true
      mocks.switchProjectMock.mockImplementation(() => {
        if (firstCall) {
          firstCall = false
          return stalled
        }
        return Promise.resolve()
      })

      const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
      const runSwitch = useProjectSwitchState()

      const first = runSwitch('p1') // reconcile path (p1 already active)
      void first.catch(() => { /* watchdog rejection asserted below */ })
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.switchProjectMock).toHaveBeenCalledWith('p1')
      // The reconcile path never tears down sessions.
      expect(useSessionStore.getState().sessions).toBeNull()

      // A newer REAL switch supersedes the stalled reconcile body.
      const second = runSwitch('p2')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(useProjectStore.getState().activeProjectId).toBe('p2')
      const sessionsAfterSecond = useSessionStore.getState().sessions

      // The stalled reconcile RPC finally settles — its stale body must not
      // write anything (the supersede guard returns before any store write).
      releaseStalled?.()
      await stalled
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      expect(useProjectStore.getState().activeProjectId).toBe('p2')
      expect(useSessionStore.getState().sessions).toBe(sessionsAfterSecond)
      await expect(first).rejects.toThrow(/timed out/)
      await second
    } finally {
      vi.useRealTimers()
    }
  })

  it('A→B→A: a revisited project rehydrates from the snapshot before listSessions resolves', async () => {
    useProjectStore.setState({ projects: null, activeProjectId: 'A' })
    const rootEntriesA = [makeEntry('/A/a.ts'), makeEntry('/A/src', true)]
    useFileTreeStore.setState({
      rootPath: '/A',
      tree: { '/A': rootEntriesA, '/A/src': [makeEntry('/A/src/b.ts')] },
      expandedDirs: { '/A/src': true },
      gitStatus: { '/A/a.ts': { status: 'M', staged: false, index_status: '', worktree_status: 'M' } },
    })
    const sessionsA = [makeSession({ id: 'a1', project_id: 'A', last_active_at: '2026-05-01T00:00:00Z' })]
    useSessionStore.setState({ sessions: sessionsA, activeSessionId: 'a1' })

    const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
    const runSwitch = useProjectSwitchState()

    // First hop A→B: A's UI state is captured; B has no snapshot to hydrate.
    mocks.getProjectSwitchStateMock.mockResolvedValue(null)
    mocks.listSessionsMock.mockResolvedValue([])
    mocks.createSessionMock.mockResolvedValue(makeSession({ id: 'b-new', project_id: 'B' }))
    await runSwitch('B')
    expect(projectSnapshotCache.has('A')).toBe(true)

    // Second hop B→A: gate the listSessions RPC so we can observe the
    // synchronous hydration BEFORE the authoritative list lands.
    let releaseList: (() => void) | undefined
    const listGate = new Promise<SessionInfo[]>((resolve) => {
      releaseList = () =>
        resolve([makeSession({ id: 'a-fresh', project_id: 'A', last_active_at: '2026-06-01T00:00:00Z' })])
    })
    mocks.getProjectSwitchStateMock.mockResolvedValue(null)
    mocks.listSessionsMock.mockReturnValueOnce(listGate)

    const pending = runSwitch('A')
    // Flush microtasks until performSwitch suspends on the gated listSessions.
    for (let i = 0; i < 30; i++) await Promise.resolve()

    // Snapshot A is painted synchronously — no listSessions RPC awaited yet.
    const treeState = useFileTreeStore.getState()
    expect(treeState.rootPath).toBe('/A')
    expect(treeState.tree['/A']).toEqual(rootEntriesA)
    expect(treeState.tree['/A/src']).toEqual([makeEntry('/A/src/b.ts')])
    expect(treeState.expandedDirs).toEqual({ '/A/src': true })
    expect(treeState.gitStatus['/A/a.ts']).toEqual({ status: 'M', staged: false, index_status: '', worktree_status: 'M' })
    expect(useProjectStore.getState().activeProjectId).toBe('A')
    expect(useSessionStore.getState().sessions?.map((s) => s.id)).toEqual(['a1'])
    expect(useSessionStore.getState().activeSessionId).toBe('a1')

    // The authoritative listSessions response then overwrites the hydrated list.
    releaseList?.()
    await pending
    expect(useSessionStore.getState().sessions?.map((s) => s.id)).toEqual(['a-fresh'])
    expect(useSessionStore.getState().activeSessionId).toBe('a-fresh')
  })

  it('a superseded switch does not rehydrate its snapshot over the newer project', async () => {
    vi.useFakeTimers()
    try {
      useProjectStore.setState({ projects: null, activeProjectId: 'p0' })

      // Preload a snapshot for project A directly into the cache.
      useFileTreeStore.setState({
        rootPath: '/A',
        tree: { '/A': [makeEntry('/A/a.ts')] },
        expandedDirs: {},
        gitStatus: {},
      })
      useSessionStore.setState({ sessions: [makeSession({ id: 'a1', project_id: 'A' })], activeSessionId: 'a1' })
      projectSnapshotCache.capture('A')
      expect(projectSnapshotCache.has('A')).toBe(true)
      // Neutralise the stores so a (buggy) hydrate would be observable.
      useFileTreeStore.getState().clearTree()
      useSessionStore.setState({ sessions: null, activeSessionId: null })

      // The switch to A stalls inside its switchProject RPC.
      let releaseStalled: (() => void) | undefined
      const stalled = new Promise<void>((resolve) => {
        releaseStalled = () => resolve()
      })
      let firstCall = true
      mocks.switchProjectMock.mockImplementation(() => {
        if (firstCall) {
          firstCall = false
          return stalled
        }
        return Promise.resolve()
      })

      const { useProjectSwitchState } = await import('@/hooks/useProjectSwitchState')
      const runSwitch = useProjectSwitchState()

      const first = runSwitch('A')
      void first.catch(() => { /* watchdog rejection asserted below */ })
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.switchProjectMock).toHaveBeenCalledWith('A')

      // A newer switch supersedes it and completes.
      const second = runSwitch('B')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(useProjectStore.getState().activeProjectId).toBe('B')
      const sessionsAfterSecond = useSessionStore.getState().sessions

      // The stalled RPC finally settles — the stale body must NOT hydrate A's
      // snapshot over the newer project.
      releaseStalled?.()
      await stalled
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      expect(useProjectStore.getState().activeProjectId).toBe('B')
      expect(useFileTreeStore.getState().rootPath).not.toBe('/A')
      expect(useSessionStore.getState().sessions).toBe(sessionsAfterSecond)
      expect(useSessionStore.getState().activeSessionId).not.toBe('a1')
      await expect(first).rejects.toThrow(/timed out/)
      await second
    } finally {
      vi.useRealTimers()
    }
  })
})
