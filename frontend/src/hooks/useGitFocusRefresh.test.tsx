// Tests for useGitFocusRefresh — the window-focus trigger of git auto-fetch.
//
// The hook is isolated by mocking its two collaborators:
//   - @/api/git.requestRemoteRefresh: the RPC wrapper (the API boundary has
//     its own tests; here we only assert the hook calls it);
//   - @/api/runtime: isWailsReady/subscribe are replaced so a test can
//     control runtime readiness and emit the backend:ready event.
//
// Key contract under test: the hook itself does NO gating — every focus
// event sends one RPC, and the min-interval / auto_fetch / project gates
// are enforced server-side (covered by the Go tests for
// FrontendAPI.autoFetchOnce). No @testing-library/react in this repo;
// createRoot + jsdom pattern (see useFileDrop.test.tsx).

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { refreshSpy, readyRegistry, wailsReady } = vi.hoisted(() => ({
  refreshSpy: vi.fn<() => Promise<void>>(),
  readyRegistry: new Map<string, Array<() => void>>(),
  wailsReady: { value: true },
}))

vi.mock('@/api/git', () => ({
  requestRemoteRefresh: refreshSpy,
}))

vi.mock('@/api/runtime', () => ({
  isWailsReady: () => wailsReady.value,
  subscribe: (event: string, cb: () => void) => {
    const list = readyRegistry.get(event) ?? []
    list.push(cb)
    readyRegistry.set(event, list)
    return () => {
      readyRegistry.set(event, (readyRegistry.get(event) ?? []).filter((c) => c !== cb))
    }
  },
}))

import { useGitFocusRefresh } from '@/hooks/useGitFocusRefresh'

/** Emit a captured runtime event to all current subscribers. */
function emitRuntimeEvent(event: string): void {
  for (const cb of readyRegistry.get(event) ?? []) cb()
}

function Harness() {
  useGitFocusRefresh()
  return null
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  // Unmount any component left mounted by a previous test so listeners
  // never leak between tests.
  act(() => { root?.unmount() })

  readyRegistry.clear()
  refreshSpy.mockReset()
  refreshSpy.mockResolvedValue(undefined)
  wailsReady.value = true

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

function mount(): void {
  act(() => {
    root?.render(<Harness />)
  })
}

function dispatchFocus(): void {
  window.dispatchEvent(new Event('focus'))
}

describe('useGitFocusRefresh', () => {
  it('calls requestRemoteRefresh exactly once on window focus', () => {
    mount()

    act(() => { dispatchFocus() })

    expect(refreshSpy).toHaveBeenCalledOnce()
  })

  it('unsubscribes on unmount (repeated focus after teardown never calls the API)', () => {
    mount()
    act(() => { dispatchFocus() })
    expect(refreshSpy).toHaveBeenCalledTimes(1)

    act(() => { root?.unmount() })
    act(() => { dispatchFocus() })
    act(() => { dispatchFocus() })

    // Still exactly the one pre-unmount call.
    expect(refreshSpy).toHaveBeenCalledTimes(1)
  })

  it('sends one RPC per focus event — no client-side throttle (the 60s min-interval is a server gate)', () => {
    mount()

    act(() => {
      dispatchFocus()
      dispatchFocus()
      dispatchFocus()
    })

    // The hook must not deduplicate: the backend decides which request
    // results in an actual fetch.
    expect(refreshSpy).toHaveBeenCalledTimes(3)
  })

  it('does not attach before runtime readiness; arms after backend:ready', () => {
    wailsReady.value = false
    mount()

    // Focus during the splash phase (runtime absent) — no RPC possible.
    act(() => { dispatchFocus() })
    expect(refreshSpy).not.toHaveBeenCalled()

    // Runtime becomes ready → the listener arms and focus fires the RPC.
    act(() => { emitRuntimeEvent('backend:ready') })
    act(() => { dispatchFocus() })
    expect(refreshSpy).toHaveBeenCalledOnce()
  })
})
