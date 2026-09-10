// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Platform, Rect } from '@floating-ui/dom'

// jsdom in this environment does not expose `window.localStorage`, which
// zustand's `persist` middleware captures at store-creation time. Install an
// in-memory polyfill before any store module is imported (same pattern as
// themeStore.test.ts) so uiScaleStore — imported by floatingUiZoom — works.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  const win = (g.window as Record<string, unknown> | undefined) ?? g
  const map = new Map<string, string>()
  win.localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => { map.clear() },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size },
  }
})

import { installFloatingUiZoomCompensation } from './floatingUiZoom'
import { useUiScaleStore } from '@/stores/uiScaleStore'

/** Visual-px geometry the mock reports at zoom 1 (as a browser would). */
const REF_RECT: Rect = { x: 300, y: 150, width: 450, height: 60 }
const FLOATING_DIMENSIONS = { width: 200, height: 100 }
const CLIPPING_RECT: Rect = { x: 0, y: 0, width: 1400, height: 900 }
const CONVERT_RECT: Rect = { x: 300, y: 150, width: 200, height: 80 }

/**
 * Fresh mock platform whose geometry methods mimic the stock signatures and
 * report visual px (what a zoomed browser serves from
 * getBoundingClientRect / visualViewport). Each spy records its calls so the
 * tests can also assert `getDimensions` is never routed through a wrapper.
 */
function makeMockPlatform() {
  const getElementRects = vi.fn(async () => ({
    reference: { ...REF_RECT },
    floating: { x: 0, y: 0, ...FLOATING_DIMENSIONS },
  }))
  const getClippingRect = vi.fn(async () => ({ ...CLIPPING_RECT }))
  const convert = vi.fn(async () => ({ ...CONVERT_RECT }))
  const getDimensions = vi.fn(async () => ({ ...FLOATING_DIMENSIONS }))
  const platform = {
    _c: new Map(),
    getElementRects,
    getClippingRect,
    convertOffsetParentRelativeRectToViewportRelativeRect: convert,
    getDimensions,
    getOffsetParent: vi.fn(async () => window),
    isElement: vi.fn(async () => true),
    getDocumentElement: vi.fn(() => document.documentElement),
    getClientRects: vi.fn(() => []),
    isRTL: vi.fn(async () => false),
    getScale: vi.fn(async () => ({ x: 1, y: 1 })),
  } as unknown as Platform & Record<string, ReturnType<typeof vi.fn>>
  return { platform, getElementRects, getClippingRect, convert, getDimensions }
}

const RECT_ARGS = {
  reference: document.createElement('div'),
  floating: document.createElement('div'),
  strategy: 'fixed' as const,
}

function setZoom(percent: number) {
  useUiScaleStore.setState({ scale: percent })
}

describe('installFloatingUiZoomCompensation', () => {
  beforeEach(() => {
    setZoom(100)
  })

  it('divides reference rect coordinates by 1.5 at 150% zoom', async () => {
    const mock = makeMockPlatform()
    installFloatingUiZoomCompensation(mock.platform)
    setZoom(150)
    const rects = await mock.platform.getElementRects(RECT_ARGS)
    expect(rects.reference.x).toBeCloseTo(200)
    expect(rects.reference.y).toBeCloseTo(100)
    expect(rects.reference.width).toBeCloseTo(300)
    expect(rects.reference.height).toBeCloseTo(40)
    // Floating rect comes from getDimensions (layout px) — must stay stock.
    expect(rects.floating.width).toBe(200)
    expect(rects.floating.height).toBe(100)
    expect(rects.floating.x).toBe(0)
    expect(rects.floating.y).toBe(0)
  })

  it('divides reference rect coordinates by 0.7 at 70% zoom', async () => {
    const mock = makeMockPlatform()
    installFloatingUiZoomCompensation(mock.platform)
    setZoom(70)
    const rects = await mock.platform.getElementRects(RECT_ARGS)
    expect(rects.reference.x).toBeCloseTo(428.571, 2)
    expect(rects.reference.y).toBeCloseTo(214.285, 2)
    expect(rects.reference.width).toBeCloseTo(642.857, 2)
    expect(rects.floating.width).toBe(200)
    expect(rects.floating.height).toBe(100)
  })

  it('is identity at 100% zoom — the stock result object passes through', async () => {
    const mock = makeMockPlatform()
    installFloatingUiZoomCompensation(mock.platform)
    setZoom(100)
    const rects = await mock.platform.getElementRects(RECT_ARGS)
    // Same values as the mock produced, and the very same object identity:
    // at zoom 1 the wrapper short-circuits without touching the result.
    expect(rects).toBe(await Promise.resolve(
      await (mock.getElementRects.mock.results[0]?.value as ReturnType<typeof mock.getElementRects>),
    ))
    expect(rects.reference.x).toBe(300)
    expect(rects.reference.width).toBe(450)
  })

  it('divides getClippingRect output by the zoom factor', async () => {
    const mock = makeMockPlatform()
    installFloatingUiZoomCompensation(mock.platform)
    setZoom(150)
    const rect = await mock.platform.getClippingRect({
      element: document.createElement('div'),
      boundary: 'clippingAncestors',
      rootBoundary: 'viewport',
      strategy: 'fixed',
    })
    expect(rect.x).toBeCloseTo(0)
    expect(rect.y).toBeCloseTo(0)
    expect(rect.width).toBeCloseTo(933.333, 2)
    expect(rect.height).toBeCloseTo(600)
  })

  it('divides convertOffsetParentRelativeRect… by NOTHING — it is left stock', async () => {
    const mock = makeMockPlatform()
    installFloatingUiZoomCompensation(mock.platform)
    setZoom(150)
    const rect = await mock.platform.convertOffsetParentRelativeRectToViewportRelativeRect({
      rect: { ...CONVERT_RECT },
      offsetParent: document.body,
      strategy: 'fixed',
    })
    // Core feeds this method values that are already in floating-ui's
    // internal space (candidate position / compensated reference rect);
    // dividing here double-compensates and breaks shift/flip (empirically
    // verified at 70% zoom). The method must remain the untouched mock.
    expect(mock.convert).toHaveBeenCalledTimes(1)
    expect(rect.x).toBe(CONVERT_RECT.x)
    expect(rect.y).toBe(CONVERT_RECT.y)
    expect(rect.width).toBe(CONVERT_RECT.width)
    expect(rect.height).toBe(CONVERT_RECT.height)
  })

  it('never wraps getDimensions (already layout px via offsetWidth fallback)', async () => {
    const mock = makeMockPlatform()
    installFloatingUiZoomCompensation(mock.platform)
    setZoom(150)
    const dims = await mock.platform.getDimensions(document.createElement('div'))
    // Untouched mock: the install function never replaces this method.
    expect(mock.getDimensions).toHaveBeenCalledTimes(1)
    expect(dims.width).toBe(200)
    expect(dims.height).toBe(100)
  })

  it('is idempotent — installing twice never double-divides', async () => {
    const mock = makeMockPlatform()
    installFloatingUiZoomCompensation(mock.platform)
    installFloatingUiZoomCompensation(mock.platform)
    installFloatingUiZoomCompensation(mock.platform)
    setZoom(150)
    const rects = await mock.platform.getElementRects(RECT_ARGS)
    // One division only: 300 / 1.5 = 200 (not 300 / 1.5 / 1.5).
    expect(rects.reference.x).toBeCloseTo(200)
    const rect = await mock.platform.getClippingRect({
      element: document.createElement('div'),
      boundary: 'clippingAncestors',
      rootBoundary: 'viewport',
      strategy: 'fixed',
    })
    expect(rect.width).toBeCloseTo(933.333, 2)
  })

  it('keeps the stock method as the inner call (spies still record invocations)', async () => {
    const mock = makeMockPlatform()
    installFloatingUiZoomCompensation(mock.platform)
    setZoom(150)
    await mock.platform.getElementRects(RECT_ARGS)
    expect(mock.getElementRects).toHaveBeenCalledTimes(1)
    await mock.platform.convertOffsetParentRelativeRectToViewportRelativeRect({
      rect: { ...CONVERT_RECT },
      offsetParent: document.body,
      strategy: 'fixed',
    })
    expect(mock.convert).toHaveBeenCalledTimes(1)
  })

  it('returns the patched platform object', () => {
    const mock = makeMockPlatform()
    const returned = installFloatingUiZoomCompensation(mock.platform)
    expect(returned).toBe(mock.platform)
  })
})
