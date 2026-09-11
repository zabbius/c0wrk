// @vitest-environment jsdom
//
// Unit tests for the sound-event hook.
//
// `classifySessionEvent` is a pure mapping and is tested without any runtime.
// `useSoundEvents` is additionally pinned to NOT own the audio unlock: the
// persistent gesture/visibility listeners are registered once at App start
// (App.tsx), so they exist even with no active session — a state in which this
// hook is a no-op. Here we verify the hook only wires session subscriptions.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// The unlock initialiser lives in lib/sound, but ownership must belong to App —
// spy on it here to prove the hook never calls it. playSound is stubbed so no
// real audio work happens.
vi.mock('@/lib/sound', () => ({
  playSound: vi.fn(),
  initSoundUnlock: vi.fn(),
}))
vi.mock('@/api/runtime', () => ({
  onSessionEvent: vi.fn(() => () => {}),
}))

import { classifySessionEvent, useSoundEvents } from '@/hooks/events/useSoundEvents'
import { initSoundUnlock } from '@/lib/sound'
import { onSessionEvent } from '@/api/runtime'
import type { SessionEventKey } from '@/types/events'

describe('classifySessionEvent', () => {
  it('maps task_complete (success) to a success tone', () => {
    expect(classifySessionEvent('task_complete', { success: true })).toBe('success')
  })

  it('maps task_complete (default success) to a success tone', () => {
    // success is optional; its absence means a clean finish.
    expect(classifySessionEvent('task_complete', { output: 'done' })).toBe('success')
  })

  it('maps a degraded task_complete (success:false) to an error tone, not success', () => {
    // A partial/failed/aborted execution must NOT sound positive.
    expect(
      classifySessionEvent('task_complete', { success: false, completion: 'partial' }),
    ).toBe('error')
  })

  it('maps interactive prompts to the attention tone', () => {
    const attentionEvents: SessionEventKey[] = [
      'ask_user',
      'step_limit',
      'tool_confirm',
      'plan_review_ready',
      'task_failed_resumable',
      'goal_proposal',
    ]
    for (const event of attentionEvents) {
      expect(classifySessionEvent(event, {})).toBe('attention')
    }
  })

  it('maps error and task_cancelled to the error tone', () => {
    expect(classifySessionEvent('error', { error: 'boom' })).toBe('error')
    expect(classifySessionEvent('task_cancelled', undefined)).toBe('error')
  })

  it('returns null (silent) for progress / streaming / lifecycle events', () => {
    // These churn constantly during a run — never audible.
    const silentEvents: SessionEventKey[] = [
      'routing',
      'step_start',
      'step_complete',
      'thought',
      'tool_call',
      'tool_result',
      'assistant_chunk',
      'assistant_done',
      'plan_step_start',
      'plan_step_complete',
      'context_fill',
      'reflection',
      'goal_status',
      'goal_progress',
    ]
    for (const event of silentEvents) {
      expect(classifySessionEvent(event, {})).toBeNull()
    }
  })

  it('handles null/undefined data defensively', () => {
    expect(classifySessionEvent('task_complete', null)).toBe('success')
    expect(classifySessionEvent('task_complete', undefined)).toBe('success')
    expect(classifySessionEvent('ask_user', null)).toBe('attention')
    expect(classifySessionEvent('error', null)).toBe('error')
  })
})

/** Mount the hook via a minimal probe component and return an unmount fn. */
async function mountSoundEvents(sessionId: string | null): Promise<() => Promise<void>> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)

  function Probe(): null {
    useSoundEvents(sessionId)
    return null
  }

  await act(async () => {
    // createElement (not JSX) so this stays a .ts file.
    root.render(createElement(Probe))
  })

  return async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
}

describe('useSoundEvents — unlock ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('does not initialise the unlock and subscribes to nothing without a session', async () => {
    const unmount = await mountSoundEvents(null)
    expect(vi.mocked(initSoundUnlock)).not.toHaveBeenCalled()
    expect(vi.mocked(onSessionEvent)).not.toHaveBeenCalled()
    await unmount()
  })

  it('subscribes to the session events but still never owns the unlock', async () => {
    const unmount = await mountSoundEvents('s1')
    expect(vi.mocked(onSessionEvent)).toHaveBeenCalled()
    // Ownership moved to App: the hook must not register the unlock itself.
    expect(vi.mocked(initSoundUnlock)).not.toHaveBeenCalled()
    await unmount()
  })
})
