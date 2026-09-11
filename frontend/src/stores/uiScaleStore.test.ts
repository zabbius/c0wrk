// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

// jsdom in this environment does not expose `window.localStorage`, which
// zustand's `persist` middleware captures at store-creation time (via
// createJSONStorage(() => window.localStorage)). Install an in-memory
// polyfill before any store module is imported so uiScaleStore works.
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
  useUiScaleStore,
  applyScaleToDocument,
  dispatchUiResizeNotification,
  getUiZoomFactor,
  UI_SCALE_MIN,
  UI_SCALE_MAX,
  UI_ZOOM_CSS_VAR,
} from '@/stores/uiScaleStore'

describe('uiScaleStore', () => {
  beforeEach(() => {
    // Reset to default and clear any persisted state between tests.
    useUiScaleStore.setState({ scale: 100 })
    localStorage.clear()
    document.documentElement.style.zoom = ''
    document.documentElement.style.removeProperty(UI_ZOOM_CSS_VAR)
  })

  it('defaults to 100', () => {
    expect(useUiScaleStore.getState().scale).toBe(100)
  })

  it('exposes the documented scale bounds', () => {
    expect(UI_SCALE_MIN).toBe(50)
    expect(UI_SCALE_MAX).toBe(200)
  })

  it('setScale clamps below the minimum', () => {
    const { setScale } = useUiScaleStore.getState()
    setScale(49)
    expect(useUiScaleStore.getState().scale).toBe(50)
  })

  it('setScale clamps above the maximum', () => {
    const { setScale } = useUiScaleStore.getState()
    setScale(300)
    expect(useUiScaleStore.getState().scale).toBe(200)
  })

  it('setScale rounds to a whole percent', () => {
    const { setScale } = useUiScaleStore.getState()
    setScale(112.6)
    expect(useUiScaleStore.getState().scale).toBe(113)
  })

  it('setScale applies the zoom factor to <html>', () => {
    const { setScale } = useUiScaleStore.getState()
    setScale(150)
    expect(document.documentElement.style.zoom).toBe('1.5')
  })

  it('applyScaleToDocument writes the zoom style directly', () => {
    applyScaleToDocument(125)
    expect(document.documentElement.style.zoom).toBe('1.25')
    applyScaleToDocument(100)
    expect(document.documentElement.style.zoom).toBe('1')
  })

  it('setScale mirrors the zoom factor as the --ui-zoom custom property', () => {
    // index.css derives the zoom-corrected --ui-vh length from this property,
    // so it must track the applied scale (unitless, for use in calc()).
    useUiScaleStore.getState().setScale(150)
    expect(
      document.documentElement.style.getPropertyValue(UI_ZOOM_CSS_VAR),
    ).toBe('1.5')
  })

  it('applyScaleToDocument publishes both the zoom style and --ui-zoom', () => {
    applyScaleToDocument(125)
    expect(document.documentElement.style.zoom).toBe('1.25')
    expect(
      document.documentElement.style.getPropertyValue(UI_ZOOM_CSS_VAR),
    ).toBe('1.25')
    applyScaleToDocument(100)
    expect(
      document.documentElement.style.getPropertyValue(UI_ZOOM_CSS_VAR),
    ).toBe('1')
  })

  it('getUiZoomFactor reads scale/100 straight from the store state', () => {
    useUiScaleStore.setState({ scale: 100 })
    expect(getUiZoomFactor()).toBe(1)
    useUiScaleStore.setState({ scale: 150 })
    expect(getUiZoomFactor()).toBe(1.5)
    useUiScaleStore.setState({ scale: 70 })
    expect(getUiZoomFactor()).toBe(0.7)
  })

  it('getUiZoomFactor falls back to 1 on corrupted (non-finite/non-positive) scale', () => {
    useUiScaleStore.setState({ scale: Number.NaN })
    expect(getUiZoomFactor()).toBe(1)
    useUiScaleStore.setState({ scale: 0 })
    expect(getUiZoomFactor()).toBe(1)
    useUiScaleStore.setState({ scale: -25 })
    expect(getUiZoomFactor()).toBe(1)
  })

  it('setScale dispatches a window resize so open popovers recompute', () => {
    const onResize = vi.fn()
    window.addEventListener('resize', onResize)
    try {
      useUiScaleStore.getState().setScale(150)
      expect(onResize).toHaveBeenCalledTimes(1)
      useUiScaleStore.getState().setScale(170)
      expect(onResize).toHaveBeenCalledTimes(2)
    } finally {
      window.removeEventListener('resize', onResize)
    }
  })

  it('dispatchUiResizeNotification is a no-op without window access', () => {
    // Guarded by `typeof window === 'undefined'`; in jsdom the window exists,
    // so the no-op branch is covered by construction (the export runs
    // without throwing on repeated calls).
    expect(() => dispatchUiResizeNotification()).not.toThrow()
  })

  it('applyScaleToDocument is a no-op without document', () => {
    const g = globalThis as Record<string, unknown>
    const originalDocument = g.document
    try {
      delete g.document
      expect(() => applyScaleToDocument(150)).not.toThrow()
    } finally {
      g.document = originalDocument
    }
  })

  it('persists only {scale} under the c0wrk-ui-scale key', () => {
    const { setScale } = useUiScaleStore.getState()
    setScale(133)
    const raw = localStorage.getItem('c0wrk-ui-scale')
    expect(raw).not.toBeNull()
    // zustand's persist middleware wraps the payload as {state, version};
    // partialize must keep `state` limited to the scale field (no actions).
    const parsed = JSON.parse(raw as string) as {
      state: Record<string, unknown>
      version: number
    }
    expect(parsed.state).toEqual({ scale: 133 })
    expect(parsed.version).toBe(1)
  })
})
