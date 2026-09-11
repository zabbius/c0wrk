// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

// revealInWorkspace talks to the file-tree store and (via the routing
// helper) the UI/git-panel/project stores. The RPC layer (listDirectory)
// is mocked inert; the stores are the REAL zustand stores so the routing
// integration is exercised end-to-end.

const listDirectoryMock = vi.fn(async () => [] as never[])

vi.mock('@/api/workspace', () => ({
  listDirectory: (...args: unknown[]) => listDirectoryMock(...(args as [])),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { revealInWorkspace } from './revealInWorkspace'
import { useFileTreeStore } from '@/stores/fileTreeStore'
import { useProjectStore } from '@/stores/projectStore'
import { useGitPanelStore, selectGitPanelTab } from '@/stores/gitPanelStore'
import { useUIStore, selectWorkspaceTab } from '@/stores/uiStore'

beforeEach(() => {
  useFileTreeStore.getState().clearTree()
  useFileTreeStore.getState().setRootPath('/ws')
  useProjectStore.setState({ activeProjectId: 'p1' })
  useGitPanelStore.getState().reset()
  useUIStore.setState({ workspaceTabByProject: { p1: 'semantics' }, sidebarCollapsed: false })
})

describe('revealInWorkspace — explorer routing', () => {
  it('routes to the standalone Explorer tab for a non-git project', async () => {
    await revealInWorkspace('/ws/src/foo.ts')

    expect(selectWorkspaceTab(useUIStore.getState(), 'p1')).toBe('explorer')
    expect(selectGitPanelTab(useGitPanelStore.getState(), 'p1')).toBe('files') // untouched default
  })

  it('routes to the Git panel files section for a git project', async () => {
    useGitPanelStore.getState().setGitRepo(true, 'p1')
    useGitPanelStore.getState().setActiveTab('p1', 'history')

    await revealInWorkspace('/ws/src/foo.ts')

    expect(selectWorkspaceTab(useUIStore.getState(), 'p1')).toBe('git')
    expect(selectGitPanelTab(useGitPanelStore.getState(), 'p1')).toBe('files')
  })

  it('a stale repo check for another project routes to Explorer (fail closed)', async () => {
    useGitPanelStore.getState().setGitRepo(true, 'other-project')

    await revealInWorkspace('/ws/src/foo.ts')

    expect(selectWorkspaceTab(useUIStore.getState(), 'p1')).toBe('explorer')
  })

  it('no-ops without a workspace root', async () => {
    useFileTreeStore.getState().setRootPath('')
    await revealInWorkspace('/ws/src/foo.ts')
    // No crash and no tab switch attempted.
    expect(selectWorkspaceTab(useUIStore.getState(), 'p1')).toBe('semantics')
  })
})
