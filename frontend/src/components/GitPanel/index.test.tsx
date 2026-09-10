// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// GitPanel's own tab routing is under test: everything it renders per tab
// (and the side-effect hook) is mocked with sentinels so assertions stay
// about WHICH section is mounted for WHICH internal tab.
vi.mock('@/hooks/useGitStatusEvents', () => ({ useGitStatusEvents: vi.fn() }))
vi.mock('./GitPanelToolbar', () => ({ GitPanelToolbar: () => createElement('div', { 'data-testid': 'git-toolbar' }) }))
vi.mock('./ChangesList', () => ({
  ChangesList: () => createElement('div', { 'data-testid': 'changes-list' }, 'CHANGES'),
}))
vi.mock('./CommitSection', () => ({ CommitSection: () => createElement('div', { 'data-testid': 'commit-section' }) }))
vi.mock('./GitHistoryTab', () => ({
  GitHistoryTab: () => createElement('div', { 'data-testid': 'history-tab' }, 'HISTORY'),
}))
vi.mock('./GitPanelFooter', () => ({ GitPanelFooter: () => createElement('div', { 'data-testid': 'git-footer' }) }))
vi.mock('./BranchPicker', () => ({ BranchPicker: () => null }))
vi.mock('@/components/layout/FileTreePanel', () => ({
  FileTreePanel: () => createElement('div', { 'data-testid': 'file-tree' }, 'FILE_TREE'),
}))

import { GitPanel } from './index'
import { useGitPanelStore } from '@/stores/gitPanelStore'

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderPanel(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  root = r
  act(() => {
    r.render(createElement(GitPanel))
  })
}

function has(testId: string): boolean {
  return container?.querySelector(`[data-testid="${testId}"]`) != null
}

beforeEach(() => {
  useGitPanelStore.getState().reset()
  act(() => {
    useGitPanelStore.getState().setGitRepo(true, 'p1')
  })
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

describe('GitPanel — internal tab routing', () => {
  it('renders files | changes | history with files first and active by default', () => {
    renderPanel()

    const labels = Array.from(container!.querySelectorAll('button[type="button"]'))
      .map((b) => b.textContent?.trim())
      .filter((t): t is string => t === 'files' || t === 'changes' || t === 'history')
    expect(labels).toEqual(['files', 'changes', 'history'])

    // The default (reset) activeTab is 'files': the explorer is mounted.
    expect(has('file-tree')).toBe(true)
    expect(has('changes-list')).toBe(false)
    expect(has('history-tab')).toBe(false)
  })

  it('switching to changes mounts the changes section and unmounts the explorer', () => {
    renderPanel()

    const changesBtn = Array.from(container!.querySelectorAll<HTMLButtonElement>('button[type="button"]'))
      .find((b) => b.textContent?.trim() === 'changes')!
    act(() => {
      changesBtn.click()
    })

    expect(useGitPanelStore.getState().activeTab).toBe('changes')
    expect(has('file-tree')).toBe(false)
    expect(has('changes-list')).toBe(true)
    expect(has('commit-section')).toBe(true)
  })

  it('switching to history mounts the history tab', () => {
    renderPanel()

    const historyBtn = Array.from(container!.querySelectorAll<HTMLButtonElement>('button[type="button"]'))
      .find((b) => b.textContent?.trim() === 'history')!
    act(() => {
      historyBtn.click()
    })

    expect(useGitPanelStore.getState().activeTab).toBe('history')
    expect(has('file-tree')).toBe(false)
    expect(has('history-tab')).toBe(true)
  })
})
