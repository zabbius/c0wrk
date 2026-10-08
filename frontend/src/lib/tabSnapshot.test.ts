// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom in this environment does not expose `window.localStorage`; the module
// under test transitively imports uiStore, whose persist middleware captures
// localStorage at store-creation time (same pattern as inputModeStore.test.ts).
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  const win = (g.window as Record<string, unknown> | undefined) ?? g
  const map = new Map<string, string>()
  win.localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size },
  }
})

import {
  DEFAULT_INPUT_SNAPSHOT,
  captureTabUI,
  createDefaultTabUI,
  isSameTabUI,
  restoreTabUI,
  sanitizeTabUI,
  type TabUISource,
} from './tabSnapshot'

function liveSource(): TabUISource {
  return {
    workspaceTabByProject: { p1: 'git', p2: 'research' },
    researchSegmentByProject: { p1: 'papers' },
    inputMode: { mode: 'terminal', height: 420, collapsedHeight: 380, isExpanded: false },
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('createDefaultTabUI', () => {
  it('returns a fully-default state', () => {
    expect(createDefaultTabUI()).toEqual({
      workspaceTabByProject: {},
      researchSegmentByProject: {},
      inputMode: { mode: 'chat', height: 200, collapsedHeight: 200, isExpanded: false },
    })
  })

  it('returns fresh copies each call (mutations never leak between defaults)', () => {
    const a = createDefaultTabUI()
    const b = createDefaultTabUI()
    expect(a).not.toBe(b)
    expect(a.inputMode).not.toBe(b.inputMode)
    a.workspaceTabByProject.p1 = 'git'
    expect(b.workspaceTabByProject).toEqual({})
  })
})

describe('captureTabUI (pure capture)', () => {
  it('snapshots the three live slices', () => {
    expect(captureTabUI(liveSource())).toEqual({
      workspaceTabByProject: { p1: 'git', p2: 'research' },
      researchSegmentByProject: { p1: 'papers' },
      inputMode: { mode: 'terminal', height: 420, collapsedHeight: 380, isExpanded: false },
    })
  })

  it('defensively copies: later source mutations never leak into the snapshot', () => {
    const source = liveSource()
    const snapshot = captureTabUI(source)

    source.workspaceTabByProject.p1 = 'explorer'
    source.researchSegmentByProject.p2 = 'dashboard'
    source.inputMode.height = 999

    expect(snapshot.workspaceTabByProject).toEqual({ p1: 'git', p2: 'research' })
    expect(snapshot.researchSegmentByProject).toEqual({ p1: 'papers' })
    expect(snapshot.inputMode.height).toBe(420)
  })

  it('drops garbage entries from the source maps (fail-closed both ways)', () => {
    // Deliberate garbage typed as a live source — capture must sanitize it.
    const polluted = {
      workspaceTabByProject: { p1: 'git', p2: 'bogus', p3: 42 },
      researchSegmentByProject: { p1: 'dashboard', p2: 'reader' },
      inputMode: { mode: 'chat', height: 300, collapsedHeight: 300, isExpanded: true },
    } as unknown as TabUISource
    const snapshot = captureTabUI(polluted)

    expect(snapshot.workspaceTabByProject).toEqual({ p1: 'git' })
    expect(snapshot.researchSegmentByProject).toEqual({ p1: 'dashboard' })
  })
})

describe('restoreTabUI (pure restore)', () => {
  it('round-trips a capture identically', () => {
    const captured = captureTabUI(liveSource())

    // The incoming tab's snapshot is restored against a DIFFERENT live input
    // state (the fallback) — the snapshot's own values must win.
    const restored = restoreTabUI(captured, DEFAULT_INPUT_SNAPSHOT)

    expect(restored).toEqual(captured)
    expect(restored).toEqual({
      workspaceTabByProject: { p1: 'git', p2: 'research' },
      researchSegmentByProject: { p1: 'papers' },
      inputMode: { mode: 'terminal', height: 420, collapsedHeight: 380, isExpanded: false },
    })
  })

  it('round-trip is isolated: live mutations between capture and restore do not leak', () => {
    const source = liveSource()
    const captured = captureTabUI(source)

    source.workspaceTabByProject.p1 = 'explorer'
    source.inputMode.mode = 'chat'

    expect(restoreTabUI(captured, source.inputMode)).toEqual(captured)
  })

  it('falls back to the caller-supplied live input for wrong-typed/missing fields', () => {
    const fallback = { mode: 'terminal' as const, height: 555, collapsedHeight: 444, isExpanded: true }

    expect(restoreTabUI(undefined, fallback).inputMode).toEqual(fallback)
    expect(restoreTabUI(null, fallback).inputMode).toEqual(fallback)
    expect(restoreTabUI(42, fallback).inputMode).toEqual(fallback)
    expect(restoreTabUI({}, fallback).inputMode).toEqual(fallback)
    expect(restoreTabUI({ inputMode: { mode: 'reader', height: 'wide' } }, fallback).inputMode).toEqual(fallback)
    // Non-finite numbers and wrong-typed booleans fall back per field; a
    // valid mode ('chat') passes through unchanged.
    expect(
      restoreTabUI(
        { inputMode: { mode: 'chat', height: NaN, collapsedHeight: Infinity, isExpanded: 'yes' } },
        fallback,
      ).inputMode,
    ).toEqual({ mode: 'chat', height: 555, collapsedHeight: 444, isExpanded: true })
  })

  it('discards a non-object map outright and filters invalid entries from object maps', () => {
    const fallback = { mode: 'chat' as const, height: 200, collapsedHeight: 200, isExpanded: false }

    const nonObject = restoreTabUI(
      { workspaceTabByProject: 'nope', researchSegmentByProject: 7 },
      fallback,
    )
    expect(nonObject.workspaceTabByProject).toEqual({})
    expect(nonObject.researchSegmentByProject).toEqual({})

    const mixed = restoreTabUI(
      {
        workspaceTabByProject: { keep: 'semantics', dropUnknown: 'graph', dropNumber: 3 },
        researchSegmentByProject: { keep: 'papers', dropUnknown: 'reader' },
      },
      fallback,
    )
    expect(mixed.workspaceTabByProject).toEqual({ keep: 'semantics' })
    expect(mixed.researchSegmentByProject).toEqual({ keep: 'papers' })
  })
})

describe('sanitizeTabUI', () => {
  it('uses the documented defaults when no fallback is supplied', () => {
    expect(sanitizeTabUI(undefined)).toEqual(createDefaultTabUI())
  })

  it('never returns the input object (fresh allocation on every call)', () => {
    const raw = {
      workspaceTabByProject: { p1: 'git' },
      researchSegmentByProject: {},
      inputMode: { mode: 'chat', height: 300, collapsedHeight: 300, isExpanded: false },
    }
    const out = sanitizeTabUI(raw)
    expect(out).not.toBe(raw)
    expect(out.workspaceTabByProject).not.toBe(raw.workspaceTabByProject)
    expect(out.inputMode).not.toBe(raw.inputMode)
    expect(out).toEqual(raw)
  })
})

describe('isSameTabUI', () => {
  it('treats content-equal states as equal regardless of object identity or key order', () => {
    const a = captureTabUI(liveSource())
    const b = restoreTabUI(a, DEFAULT_INPUT_SNAPSHOT)
    expect(b).not.toBe(a)
    expect(isSameTabUI(a, b)).toBe(true)

    const reordered = captureTabUI({
      workspaceTabByProject: { p2: 'research', p1: 'git' },
      researchSegmentByProject: { p1: 'papers' },
      inputMode: { mode: 'terminal', height: 420, collapsedHeight: 380, isExpanded: false },
    })
    expect(isSameTabUI(a, reordered)).toBe(true)
  })

  it('detects map and scalar differences', () => {
    const base = captureTabUI(liveSource())

    const otherTabValue = captureTabUI({ ...liveSource(), workspaceTabByProject: { p1: 'explorer', p2: 'research' } })
    const missingEntry = captureTabUI({ ...liveSource(), workspaceTabByProject: { p1: 'git' } })
    const extraSegment = captureTabUI({ ...liveSource(), researchSegmentByProject: { p1: 'papers', p2: 'dashboard' } })
    const otherMode = captureTabUI({ ...liveSource(), inputMode: { mode: 'chat', height: 420, collapsedHeight: 380, isExpanded: false } })
    const otherHeight = captureTabUI({ ...liveSource(), inputMode: { mode: 'terminal', height: 421, collapsedHeight: 380, isExpanded: false } })
    const otherCollapsed = captureTabUI({ ...liveSource(), inputMode: { mode: 'terminal', height: 420, collapsedHeight: 381, isExpanded: false } })
    const otherExpanded = captureTabUI({ ...liveSource(), inputMode: { mode: 'terminal', height: 420, collapsedHeight: 380, isExpanded: true } })

    expect(isSameTabUI(base, otherTabValue)).toBe(false)
    expect(isSameTabUI(base, missingEntry)).toBe(false)
    expect(isSameTabUI(base, extraSegment)).toBe(false)
    expect(isSameTabUI(base, otherMode)).toBe(false)
    expect(isSameTabUI(base, otherHeight)).toBe(false)
    expect(isSameTabUI(base, otherCollapsed)).toBe(false)
    expect(isSameTabUI(base, otherExpanded)).toBe(false)
    expect(isSameTabUI(base, base)).toBe(true)
  })
})
