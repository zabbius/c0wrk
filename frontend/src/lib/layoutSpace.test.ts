// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getLayoutViewport, toLayoutTriggerRect } from './layoutSpace'
import { useUiScaleStore } from '@/stores/uiScaleStore'

// jsdom reports no geometry; both viewport extents are stubbed so the
// conversion can be asserted against concrete numbers.
const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
}

describe('layoutSpace — UI-scale coordinate conversion', () => {
  beforeEach(() => {
    setViewport(1000, 800)
    useUiScaleStore.setState({ scale: 100 })
  })

  afterEach(() => {
    useUiScaleStore.setState({ scale: 100 })
    if (originalInnerWidth) Object.defineProperty(window, 'innerWidth', originalInnerWidth)
    if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight)
  })

  it('is the identity at scale 100', () => {
    expect(getLayoutViewport()).toEqual({ width: 1000, height: 800 })
  })

  it('divides the VISUAL viewport by the zoom factor', () => {
    // window.innerWidth/innerHeight are visual px; a fixed element's
    // left/top are layout px, so the layout viewport is the inner size / zoom.
    useUiScaleStore.setState({ scale: 150 })
    expect(getLayoutViewport()).toEqual({ width: 1000 / 1.5, height: 800 / 1.5 })

    useUiScaleStore.setState({ scale: 50 })
    expect(getLayoutViewport()).toEqual({ width: 2000, height: 1600 })
  })

  it('accepts an explicit zoom (pure, no store read)', () => {
    expect(getLayoutViewport(2)).toEqual({ width: 500, height: 400 })
  })

  it('converts a getBoundingClientRect trigger rect into layout px', () => {
    const visual = { top: 150, bottom: 180, left: 300, width: 120 }
    expect(toLayoutTriggerRect(visual, 1.5)).toEqual({
      top: 100,
      bottom: 120,
      left: 200,
      width: 80,
    })
  })

  it('reads the live zoom from the store when none is given', () => {
    useUiScaleStore.setState({ scale: 200 })
    expect(toLayoutTriggerRect({ top: 100, bottom: 140, left: 200, width: 40 })).toEqual({
      top: 50,
      bottom: 70,
      left: 100,
      width: 20,
    })
  })

  it('falls back to zoom 1 on corrupted persisted scale', () => {
    useUiScaleStore.setState({ scale: Number.NaN })
    expect(getLayoutViewport()).toEqual({ width: 1000, height: 800 })
  })
})
