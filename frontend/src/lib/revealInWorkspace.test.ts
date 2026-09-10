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
import { useGitPanelStore } from '@/stores/gitPanelStore'
import { useUIStore } from '@/stores/uiStore'

beforeEach(() => {
  useFileTreeStore.getState().clearTree()
  useFileTreeStore.getState().setRootPath('/ws')
  useProjectStore.setState({ activeProjectId: 'p1' })
  useGitPanelStore.getState().reset()
  useUIStore.setState({ workspaceTab: 'semantics', sidebarCollapsed: false })
})

describe('revealInWorkspace — explorer routing', () => {
  it('routes to the standalone Explorer tab for a non-git project', async () => {
    await revealInWorkspace('/ws/src/foo.ts')

    expect(useUIStore.getState().workspaceTab).toBe('explorer')
    expect(useGitPanelStore.getState().activeTab).toBe('files') // untouched default
  })

  it('routes to the Git panel files section for a git project', async () => {
    useGitPanelStore.getState().setGitRepo(true, 'p1')
    useGitPanelStore.getState().setActiveTab('history')

    await revealInWorkspace('/ws/src/foo.ts')

    expect(useUIStore.getState().workspaceTab).toBe('git')
    expect(useGitPanelStore.getState().activeTab).toBe('files')
  })

  it('a stale repo check for another project routes to Explorer (fail closed)', async () => {
    useGitPanelStore.getState().setGitRepo(true, 'other-project')

    await revealInWorkspace('/ws/src/foo.ts')

    expect(useUIStore.getState().workspaceTab).toBe('explorer')
  })

  it('no-ops without a workspace root', async () => {
    useFileTreeStore.getState().setRootPath('')
    await revealInWorkspace('/ws/src/foo.ts')
    // No crash and no tab switch attempted.
    expect(useUIStore.getState().workspaceTab).toBe('semantics')
  })
})
