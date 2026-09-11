// @vitest-environment jsdom
//
// initSoundUnlock — app-start audio-unlock wiring.
//
// The persistent gesture/visibility listeners that revive a suspended
// AudioContext must exist for the lifetime of the app, independent of any
// active session (App calls initSoundUnlock in a mount effect; the function
// itself takes no session argument). With no session the webview can still
// leave the context suspended — notably right after a reload — and a gesture or
// visibility event is the only thing that can wake it. This test pins both
// halves of the contract: every listener kind is registered, and repeated calls
// install exactly one listener per kind (idempotency, including StrictMode's
// double mount).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initSoundUnlock, __resetSoundModule } from '@/lib/sound'

const WINDOW_TYPES = ['pointerdown', 'keydown', 'touchstart'] as const

/** Count how many times a spy recorded a listener for `type`. */
function countFor(spy: { mock: { calls: unknown[][] } }, type: string): number {
  return spy.mock.calls.filter((call) => call[0] === type).length
}

describe('initSoundUnlock — app-start unlock wiring (session-independent)', () => {
  beforeEach(() => {
    __resetSoundModule()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetSoundModule()
  })

  it('attaches all four persistent listeners with no active session', () => {
    const windowAdd = vi.spyOn(window, 'addEventListener')
    const documentAdd = vi.spyOn(document, 'addEventListener')

    initSoundUnlock()

    for (const type of WINDOW_TYPES) {
      expect(countFor(windowAdd, type)).toBe(1)
    }
    expect(countFor(documentAdd, 'visibilitychange')).toBe(1)
  })

  it('is idempotent: repeated calls never duplicate listeners', () => {
    const windowAdd = vi.spyOn(window, 'addEventListener')
    const documentAdd = vi.spyOn(document, 'addEventListener')

    initSoundUnlock()
    initSoundUnlock()
    initSoundUnlock()

    for (const type of WINDOW_TYPES) {
      expect(countFor(windowAdd, type)).toBe(1)
    }
    expect(countFor(documentAdd, 'visibilitychange')).toBe(1)
  })
})
