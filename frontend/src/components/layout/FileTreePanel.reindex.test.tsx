// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// The panel must never reach the Wails backend: mock every RPC it makes on
// mount (list / watch / git status) plus the reindex action under test.
vi.mock('@/api/workspace', () => ({
  listDirectory: vi.fn(async () => []),
  getGitStatus: vi.fn(async () => ({})),
  watchDirectory: vi.fn(async () => undefined),
  unwatchDirectory: vi.fn(async () => undefined),
  getSessionWorkspace: vi.fn(async () => '/ws'),
}))
vi.mock('@/api/runtime', () => ({
  // FileTreePanel subscribes to workspace:tree_changed; an inert subscription
  // is enough for these tests.
  subscribe: vi.fn(() => () => undefined),
}))
vi.mock('@/api/vector', () => ({
  reindexVectorIndex: vi.fn(async () => undefined),
}))
vi.mock('@/hooks/useFileSearch', () => ({
  useFileSearch: () => ({
    filterText: '',
    filterMode: 'glob',
    isInvalidFilter: false,
    handleFilterChange: vi.fn(),
    toggleFilterMode: vi.fn(),
  }),
}))
vi.mock('./FileTreeContextMenu', () => ({ FileTreeContextMenu: () => null }))
vi.mock('./FileIcon', () => ({ FileIcon: () => null }))

import { FileTreePanel } from './FileTreePanel'
import { reindexVectorIndex } from '@/api/vector'
import { useFileTreeStore } from '@/stores/fileTreeStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useVectorIndexStore } from '@/stores/vectorIndexStore'
import type { ProjectInfo, VectorIndexStatus } from '@/types/models'

const reindexMock = vi.mocked(reindexVectorIndex)

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: 'p1',
    name: 'rootfs',
    workspace_path: '/ws',
    is_external: true,
    is_no_project: false,
    research_root: '',
    is_research: false,
    created_at: new Date(0).toISOString(),
    last_active_at: new Date(0).toISOString(),
    ...overrides,
  }
}

function setIndexState(state: VectorIndexStatus['state']): void {
  useVectorIndexStore.setState((s) => ({ status: { ...s.status, state } }))
}

function findButton(container: HTMLElement, title: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[title="${title}"]`)
}

describe('FileTreePanel — force full project reindex action', () => {
  let container: HTMLDivElement
  let root: Root | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    useProjectStore.setState({
      projects: [makeProject()],
      activeProjectId: 'p1',
    })
    useSessionStore.setState({ activeSessionId: 's1' })
    useFileTreeStore.getState().clearTree()
    setIndexState('ready')
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    container.remove()
    vi.clearAllMocks()
  })

  async function renderPanel(): Promise<void> {
    root = createRoot(container)
    await act(async () => {
      root!.render(<FileTreePanel />)
    })
  }

  it('replaces the refresh affordance and triggers a full reindex on click', async () => {
    await renderPanel()
    await act(async () => {})

    // The old manual file-tree refresh button is gone.
    expect(findButton(container, 'Refresh file tree')).toBeNull()

    const button = findButton(container, 'Force full project reindex')
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(false)

    await act(async () => {
      button!.click()
    })

    expect(reindexMock).toHaveBeenCalledTimes(1)
  })

  it('is disabled and spinning while a reindex is already in progress', async () => {
    setIndexState('reindexing')
    await renderPanel()
    await act(async () => {})

    const button = findButton(container, 'Reindexing...')
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(true)
  })

  it('is unavailable in No Project (CHAT) mode', async () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'np', is_no_project: true, workspace_path: '/np' })],
      activeProjectId: 'np',
    })
    await renderPanel()
    await act(async () => {})

    const button = findButton(container, 'Reindex unavailable')
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(true)
    expect(reindexMock).not.toHaveBeenCalled()
  })

  it('blocks duplicate clicks until the vector_index:status event arrives', async () => {
    await renderPanel()
    await act(async () => {})

    const button = findButton(container, 'Force full project reindex')
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(false)

    // First click: the optimistic latch engages immediately, before any status
    // event — the button flips to the busy state and is disabled.
    await act(async () => {
      button!.click()
    })
    expect(reindexMock).toHaveBeenCalledTimes(1)

    const busyButton = findButton(container, 'Reindexing...')
    expect(busyButton).not.toBeNull()
    expect(busyButton!.disabled).toBe(true)

    // A second click while the store still reports the stale (ready) state must
    // not fire another RPC.
    await act(async () => {
      busyButton!.click()
    })
    expect(reindexMock).toHaveBeenCalledTimes(1)

    // Backend emits the busy status → the store now owns the disabled state.
    await act(async () => {
      setIndexState('reindexing')
    })
    expect(findButton(container, 'Reindexing...')!.disabled).toBe(true)

    // Completion releases the latch and re-enables the action.
    await act(async () => {
      setIndexState('ready')
    })
    const readyButton = findButton(container, 'Force full project reindex')
    expect(readyButton).not.toBeNull()
    expect(readyButton!.disabled).toBe(false)
  })

  it('releases the optimistic latch when the reindex request is rejected', async () => {
    reindexMock.mockRejectedValueOnce(new Error('no indexer configured'))
    await renderPanel()
    await act(async () => {})

    const button = findButton(container, 'Force full project reindex')
    await act(async () => {
      button!.click()
    })
    expect(reindexMock).toHaveBeenCalledTimes(1)

    // The rejection releases the latch — the action is available again.
    const readyButton = findButton(container, 'Force full project reindex')
    expect(readyButton).not.toBeNull()
    expect(readyButton!.disabled).toBe(false)
  })

  it('releases the optimistic latch when the project becomes unavailable', async () => {
    await renderPanel()
    await act(async () => {})

    const button = findButton(container, 'Force full project reindex')
    await act(async () => {
      button!.click()
    })
    expect(reindexMock).toHaveBeenCalledTimes(1)
    expect(findButton(container, 'Reindexing...')!.disabled).toBe(true)

    // Switching to No Project invalidates the pending request.
    await act(async () => {
      useProjectStore.setState({
        projects: [makeProject({ id: 'np', is_no_project: true, workspace_path: '/np' })],
        activeProjectId: 'np',
      })
    })
    const unavailable = findButton(container, 'Reindex unavailable')
    expect(unavailable).not.toBeNull()
    expect(unavailable!.disabled).toBe(true)
  })
})
