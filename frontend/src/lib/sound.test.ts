// Unit tests for lib/sound.ts — the Web Audio notification player.
//
// The vitest environment is `node` (no DOM), so these tests install a minimal
// fake `window` + `AudioContext` and drive the module directly. They pin the
// behaviours that keep cues audible across the webview's periodic
// suspensions/interruptions — the regression behind "sound notifications
// periodically drop even though they are enabled".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { playSound, initSoundUnlock, __resetSoundModule } from '@/lib/sound'
import { useSoundStore } from '@/stores/soundStore'

interface MockOscillator {
  type: string
  frequency: { value: number }
  connect: (node: unknown) => unknown
  start: (when: number) => void
  stop: (when: number) => void
}

interface MockGain {
  gain: {
    setValueAtTime: (value: number, when: number) => void
    exponentialRampToValueAtTime: (value: number, when: number) => void
  }
  connect: (node: unknown) => unknown
}

class MockAudioContext {
  static instances: MockAudioContext[] = []
  static initialState = 'running'
  static resumeBehavior: 'resolve' | 'reject' = 'resolve'

  state: string
  readonly currentTime = 0
  readonly destination = {}
  readonly oscillators: MockOscillator[] = []

  readonly close = vi.fn((): Promise<void> => {
    this.state = 'closed'
    return Promise.resolve()
  })

  readonly resume = vi.fn((): Promise<void> => {
    if (MockAudioContext.resumeBehavior === 'reject') {
      // Mirrors WebKit refusing to resume an `interrupted` context.
      return Promise.reject(new Error('context interrupted'))
    }
    this.state = 'running'
    return Promise.resolve()
  })

  private readonly listeners = new Map<string, Array<() => void>>()

  constructor() {
    this.state = MockAudioContext.initialState
    MockAudioContext.instances.push(this)
  }

  createOscillator(): MockOscillator {
    const osc: MockOscillator = {
      type: 'sine',
      frequency: { value: 0 },
      connect: (node: unknown): unknown => node,
      start: vi.fn(),
      stop: vi.fn(),
    }
    this.oscillators.push(osc)
    return osc
  }

  createGain(): MockGain {
    return {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: (node: unknown): unknown => node,
    }
  }

  addEventListener(type: string, callback: () => void): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(callback)
    this.listeners.set(type, arr)
  }

  /** Test helper: fire a synthetic context event (e.g. `statechange`). */
  emit(type: string): void {
    for (const callback of this.listeners.get(type) ?? []) callback()
  }
}

const windowListeners = new Map<string, Array<() => void>>()
const fakeWindow = {
  AudioContext: MockAudioContext as unknown as typeof AudioContext,
  addEventListener: (type: string, callback: () => void): void => {
    const arr = windowListeners.get(type) ?? []
    arr.push(callback)
    windowListeners.set(type, arr)
  },
}

function fireWindowEvent(type: string): void {
  for (const callback of windowListeners.get(type) ?? []) callback()
}

function createdCtx(): MockAudioContext {
  const ctx = MockAudioContext.instances[MockAudioContext.instances.length - 1]
  if (!ctx) throw new Error('expected an AudioContext to have been created')
  return ctx
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  __resetSoundModule()
  MockAudioContext.instances = []
  MockAudioContext.initialState = 'running'
  MockAudioContext.resumeBehavior = 'resolve'
  windowListeners.clear()
  ;(globalThis as unknown as { window?: unknown }).window = fakeWindow
  useSoundStore.getState().setEnabled(true)
})

afterEach(() => {
  __resetSoundModule()
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('playSound', () => {
  it('stays silent and creates no context when the master toggle is off', () => {
    useSoundStore.getState().setEnabled(false)
    playSound('success')
    expect(MockAudioContext.instances).toHaveLength(0)
  })

  it('plays immediately on a running context', () => {
    playSound('attention')
    const ctx = createdCtx()
    expect(ctx.oscillators).toHaveLength(1) // attention = a single note
    expect(ctx.resume).not.toHaveBeenCalled()
  })

  it('resumes a suspended context BEFORE scheduling the cue (regression)', async () => {
    MockAudioContext.initialState = 'suspended'
    playSound('success') // three notes
    const ctx = createdCtx()
    // Nothing is scheduled while the context is not rendering.
    expect(ctx.oscillators).toHaveLength(0)
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    await flush()
    expect(ctx.oscillators).toHaveLength(3)
  })

  it('attempts recovery for WebKit non-running states other than "suspended"', async () => {
    MockAudioContext.initialState = 'interrupted'
    MockAudioContext.resumeBehavior = 'reject'
    playSound('error')
    const ctx = createdCtx()
    // The old `state === 'suspended'` check never resumed an interrupted
    // context, so the cue was silently dropped. We now attempt recovery.
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    await flush()
    expect(ctx.oscillators).toHaveLength(0) // stays silent, but never throws
  })

  it('recovers when the context leaves the running state (statechange)', () => {
    playSound('attention') // creates the context and its statechange listener
    const ctx = createdCtx()
    ctx.resume.mockClear()
    ctx.state = 'interrupted'
    ctx.emit('statechange')
    expect(ctx.resume).toHaveBeenCalledTimes(1)
  })

  it('replaces a dead (closed) context instead of staying silent', () => {
    playSound('attention') // creates the context, running
    const first = createdCtx()
    first.state = 'closed' // the webview tore the context down

    // A closed context can never render again, so the next cue must build a
    // fresh one rather than reuse the dead context forever.
    playSound('attention')
    expect(MockAudioContext.instances).toHaveLength(2)
    const second = createdCtx()
    expect(second).not.toBe(first)
    expect(second.oscillators).toHaveLength(1)
  })

  it('replaces a wedged (interrupted) context so audio recovers without a restart', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    MockAudioContext.initialState = 'interrupted'
    MockAudioContext.resumeBehavior = 'reject'

    playSound('attention')
    const first = createdCtx()
    expect(first.resume).toHaveBeenCalledTimes(1)
    await flush()
    // WebKit rejects resume() while interrupted: the cue is dropped and the
    // wedged context is discarded, not kept forever.
    expect(first.oscillators).toHaveLength(0)
    expect(first.state).toBe('closed')

    // The interruption has ended; a later cue must build a fresh, revivable
    // context and play — the regression was staying silent until an app restart.
    nowSpy.mockReturnValue(1_000 + 60_000)
    MockAudioContext.initialState = 'suspended'
    MockAudioContext.resumeBehavior = 'resolve'
    playSound('attention')
    expect(MockAudioContext.instances).toHaveLength(2)
    await flush()
    const second = createdCtx()
    expect(second).not.toBe(first)
    expect(second.oscillators).toHaveLength(1)
    nowSpy.mockRestore()
  })

  it('does not build a replacement for every cue while an interruption persists', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(5_000)
    MockAudioContext.initialState = 'interrupted'
    MockAudioContext.resumeBehavior = 'reject'

    playSound('attention')
    await flush()
    // Further cues inside the backoff window must not spin up new contexts.
    playSound('attention')
    playSound('error')
    expect(MockAudioContext.instances).toHaveLength(1)
    nowSpy.mockRestore()
  })
})

describe('initSoundUnlock', () => {
  it('is idempotent', () => {
    initSoundUnlock()
    initSoundUnlock()
    expect(windowListeners.get('pointerdown')).toHaveLength(1)
    expect(windowListeners.get('keydown')).toHaveLength(1)
    expect(windowListeners.get('touchstart')).toHaveLength(1)
  })

  it('keeps gesture listeners attached so a later suspension can recover (regression)', () => {
    initSoundUnlock()
    // The context is created lazily on the first gesture, autoplay-suspended.
    MockAudioContext.initialState = 'suspended'
    fireWindowEvent('pointerdown')
    const ctx = createdCtx()
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    // The OS interrupts the context again later…
    ctx.state = 'suspended'
    // …and a subsequent gesture must recover it. A one-shot listener would
    // already be gone — exactly the periodic-silence bug.
    fireWindowEvent('pointerdown')
    expect(ctx.resume).toHaveBeenCalledTimes(2)
  })
})
