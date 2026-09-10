// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// Heavy workspace sections are replaced with sentinels — this suite tests
// the WorkspacePanel's own layout logic (which tab strip renders, which
// content mounts, tab normalization), not the sections' internals. The
// eager git-repo detection hook is inert here; tests drive gitPanelStore
// directly to simulate a completed check.
vi.mock('./FileTreePanel', () => ({
  FileTreePanel: () => createElement('div', { 'data-testid': 'file-tree' }, 'FILE_TREE'),
}))
vi.mock('@/components/GitPanel', () => ({
  GitPanel: () => createElement('div', { 'data-testid': 'git-panel' }, 'GIT_PANEL'),
}))
vi.mock('./VectorStorePanel', () => ({ VectorStorePanel: () => null }))
vi.mock('@/components/research', () => ({ ResearchPanel: () => null }))
vi.mock('@/hooks/useProjectGitRepo', () => ({ useProjectGitRepo: vi.fn() }))

import { WorkspacePanel } from './WorkspacePanel'
import { useProjectStore } from '@/stores/projectStore'
import { useGitPanelStore } from '@/stores/gitPanelStore'
import { useUIStore } from '@/stores/uiStore'
import type { ProjectInfo } from '@/types/models'

function makeProject(overrides: Partial<ProjectInfo> & { id: string }): ProjectInfo {
  return {
    name: overrides.id,
    workspace_path: `/ws/${overrides.id}`,
    is_external: false,
    is_no_project: false,
    research_root: '',
    is_research: false,
    created_at: '2026-01-01T00:00:00Z',
    last_active_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const P1 = makeProject({ id: 'p1' })
const NO_PROJECT = makeProject({ id: 'np', is_no_project: true })

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderPanel(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  act(() => {
    r.render(createElement(WorkspacePanel))
  })
}

/** Let the normalization effect's state writes settle. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

function tabCount(): number {
  return container?.querySelectorAll('[role="tab"]').length ?? -1
}

function has(testId: string): boolean {
  return container?.querySelector(`[data-testid="${testId}"]`) != null
}

beforeEach(() => {
  useProjectStore.setState({ projects: [P1, NO_PROJECT], activeProjectId: 'p1' })
  useGitPanelStore.getState().reset()
  useUIStore.setState({ workspaceTab: 'explorer' })
})

afterEach(() => {
  if (root) {
    const r = root
    root = null
    act(() => {
      r.unmount()
    })
  }
  container?.remove()
  container = null
})

describe('WorkspacePanel — layout by git-repo state', () => {
  it('non-git project: renders the Explorer tab strip without a Git trigger, mounts FileTreePanel', async () => {
    // No completed repo check for p1 — fail-closed to the non-git layout.
    renderPanel()
    await flush()

    expect(tabCount()).toBe(3) // Explorer | Search | Research — no Git
    expect(has('file-tree')).toBe(true)
    expect(has('git-panel')).toBe(false)
  })

  it('git project: renders the Git tab strip without an Explorer trigger, mounts GitPanel', async () => {
    act(() => {
      useGitPanelStore.getState().setGitRepo(true, 'p1')
    })

    renderPanel()
    await flush()

    expect(tabCount()).toBe(3) // Git | Search | Research — no Explorer
    expect(has('git-panel')).toBe(true)
    expect(has('file-tree')).toBe(false)
  })

  it('a stale repo check for another project does not flip the layout', async () => {
    act(() => {
      useGitPanelStore.getState().setGitRepo(true, 'other-project')
    })

    renderPanel()
    await flush()

    expect(has('file-tree')).toBe(true)
    expect(has('git-panel')).toBe(false)
  })

  it('No Project (CHAT) mode: no tab strip, only the file explorer', async () => {
    useProjectStore.setState({ activeProjectId: 'np' })

    renderPanel()
    await flush()

    expect(tabCount()).toBe(0)
    expect(has('file-tree')).toBe(true)
  })
})

describe('WorkspacePanel — workspaceTab normalization', () => {
  it('git project remaps a lingering explorer tab to git + files', async () => {
    act(() => {
      useGitPanelStore.getState().setGitRepo(true, 'p1')
    })
    useUIStore.setState({ workspaceTab: 'explorer' })

    renderPanel()
    await flush()

    expect(useUIStore.getState().workspaceTab).toBe('git')
    expect(useGitPanelStore.getState().activeTab).toBe('files')
  })

  it('non-git project remaps a lingering git tab to explorer', async () => {
    useUIStore.setState({ workspaceTab: 'git' })

    renderPanel()
    await flush()

    expect(useUIStore.getState().workspaceTab).toBe('explorer')
  })

  it('switching the active project from git to non-git falls back to explorer', async () => {
    act(() => {
      useGitPanelStore.getState().setGitRepo(true, 'p1')
    })

    renderPanel()
    await flush()
    expect(useUIStore.getState().workspaceTab).toBe('git')

    // Project switch: the new project's eager check reports non-repo.
    act(() => {
      useProjectStore.setState({ activeProjectId: 'p2' })
      useGitPanelStore.getState().setGitRepo(false, 'p2')
    })
    await flush()

    expect(useUIStore.getState().workspaceTab).toBe('explorer')
    expect(has('file-tree')).toBe(true)
    expect(has('git-panel')).toBe(false)
  })
})
