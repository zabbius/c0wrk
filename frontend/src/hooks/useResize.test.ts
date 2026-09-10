// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MouseEvent as ReactMouseEvent } from 'react'

// jsdom in this environment does not expose `window.localStorage`, which
// zustand's persist middleware captures at store-creation time. Install an
// in-memory polyfill before any store module is imported (same pattern as
// themeStore.test.ts) so uiScaleStore — imported by useResize — works.
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

import { useResize, pointerDeltaToLayout } from './useResize'
import { useUiScaleStore } from '@/stores/uiScaleStore'

/**
 * The "glued divider" acceptance criterion, encoded as a property: under a
 * UI zoom of `scale`%, a pointer drag of `visualDelta` on-screen pixels must
 * produce a layout-pixel width change of visualDelta / (scale/100) — so the
 * rendered (zoomed) width change equals the pointer movement exactly and the
 * divider stays under the cursor.
 */
function expectGlued(visualDelta: number, scalePercent: number, startWidth: number): number {
  const layoutDelta = pointerDeltaToLayout(visualDelta, scalePercent)
  expect(layoutDelta).toBeCloseTo(visualDelta / (scalePercent / 100), 6)
  return startWidth + layoutDelta
}

describe('pointerDeltaToLayout', () => {
  it('is the identity at scale 100', () => {
    expect(pointerDeltaToLayout(123, 100)).toBe(123)
    expect(pointerDeltaToLayout(-40, 100)).toBe(-40)
  })

  it('divides visual pixels by the zoom factor at 150% (divider glued to cursor)', () => {
    // 150 visual px of drag → 100 layout px of panel growth.
    expect(pointerDeltaToLayout(150, 150)).toBeCloseTo(100, 6)
    expect(pointerDeltaToLayout(-150, 150)).toBeCloseTo(-100, 6)
  })

  it('amplifies the delta at 70% (smaller panels need more layout px per visual px)', () => {
    // 70 visual px of drag → 100 layout px of panel growth.
    expect(pointerDeltaToLayout(70, 70)).toBeCloseTo(100, 6)
  })

  it('round-trips with any scale in the supported 50–200 range', () => {
    for (const scale of [50, 70, 85, 100, 125, 150, 200]) {
      const layout = pointerDeltaToLayout(300, scale)
      // The rendered width change (layout × zoom) equals the pointer delta.
      expect(layout * (scale / 100)).toBeCloseTo(300, 6)
    }
  })

  it('falls back to the raw delta for non-finite or non-positive scale', () => {
    expect(pointerDeltaToLayout(100, Number.NaN)).toBe(100)
    expect(pointerDeltaToLayout(100, 0)).toBe(100)
    expect(pointerDeltaToLayout(100, -50)).toBe(100)
  })
})

describe('useResize drag compensation', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  const onChange = vi.fn<(width: number) => void>()
  // Ref-like stash: the harness writes the live handler here each render so
  // tests can trigger it without re-implementing React event plumbing.
  const handleRef: { current: (e: ReactMouseEvent) => void } = { current: () => {} }

  function Harness(): null {
    const { handleMouseDown } = useResize({
      initialWidth: 200,
      min: 50,
      max: 600,
      direction: 1,
      onChange,
    })
    handleRef.current = handleMouseDown
    return null
  }

  beforeEach(() => {
    onChange.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(createElement(Harness))
    })
  })

  afterEach(() => {
    // End any drag left open so document-level listeners are removed.
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'))
    })
    act(() => {
      root?.unmount()
    })
    root = null
    container?.remove()
    container = null
    useUiScaleStore.setState({ scale: 100 })
  })

  function startDrag(clientX: number): void {
    act(() => {
      handleRef.current({
        preventDefault: vi.fn(),
        clientX,
        clientY: 0,
      } as unknown as ReactMouseEvent)
    })
  }

  function moveTo(clientX: number): void {
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY: 0 }))
    })
  }

  it('reports raw layout pixels at scale 100', () => {
    useUiScaleStore.setState({ scale: 100 })
    startDrag(100)
    moveTo(250)
    expect(onChange).toHaveBeenLastCalledWith(350)
  })

  it('keeps the divider glued to the cursor at scale 150', () => {
    useUiScaleStore.setState({ scale: 150 })
    startDrag(100)
    moveTo(250) // 150 visual px of drag
    const expected = expectGlued(150, 150, 200)
    expect(onChange).toHaveBeenLastCalledWith(expected) // 300, not 350
    expect(onChange).toHaveBeenLastCalledWith(300)
  })

  it('keeps the divider glued to the cursor at scale 70', () => {
    useUiScaleStore.setState({ scale: 70 })
    startDrag(100)
    moveTo(170) // 70 visual px of drag
    const expected = expectGlued(70, 70, 200)
    expect(onChange).toHaveBeenLastCalledWith(expected) // 300
  })

  it('applies the current scale even when it changes mid-drag', () => {
    useUiScaleStore.setState({ scale: 100 })
    startDrag(100)
    moveTo(150) // +50 visual px at 100% → width 200 + 50 = 250
    expect(onChange).toHaveBeenLastCalledWith(250)
    // User changes zoom mid-drag (settings slider). The next move recomputes
    // from drag start (startWidth + full-drag delta / zoom): the full 200px
    // visual drag at 150% is ~133.3 layout px → width ~333.3. The divider
    // still tracks the cursor position, just from the new zoom basis.
    useUiScaleStore.setState({ scale: 150 })
    moveTo(300) // 200 visual px since drag start → /1.5 → 200 + 133.33
    expect(onChange).toHaveBeenLastCalledWith(200 + 200 / 1.5)
  })

  it('still clamps the compensated delta to max', () => {
    useUiScaleStore.setState({ scale: 150 })
    startDrag(0)
    moveTo(1200) // 1200 visual px → 800 layout px → clamped to 600
    expect(onChange).toHaveBeenLastCalledWith(600)
  })

  it('still clamps the compensated delta to min', () => {
    useUiScaleStore.setState({ scale: 50 })
    startDrag(100)
    moveTo(-400) // -500 visual px → -1000 layout px → clamped to 50
    expect(onChange).toHaveBeenLastCalledWith(50)
  })
})
