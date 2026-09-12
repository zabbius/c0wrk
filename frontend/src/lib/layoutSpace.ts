/**
 * Unit conversion between the two coordinate spaces created by the app-wide UI
 * scale, which is applied as CSS `zoom` on `<html>`.
 *
 * Measured model (headless Chromium, `html { zoom: Z }`, window 756 × 469):
 *
 * | quantity                                             | space     |
 * | ---------------------------------------------------- | --------- |
 * | `MouseEvent.clientX/clientY`                          | VISUAL px |
 * | `Element.getBoundingClientRect()`                     | VISUAL px |
 * | `window.innerWidth/innerHeight`                       | VISUAL px |
 * | `document.documentElement.clientWidth/clientHeight`   | VISUAL px |
 * | `style.left/top` on a `position: fixed` element       | LAYOUT px |
 * | `Element.offsetWidth/offsetHeight`                    | LAYOUT px |
 * | `transform: translate3d(Npx, …)`                      | LAYOUT px |
 * | `100vw`/`100vh` (resolve to the ICB = unzoomed size)  | LAYOUT px |
 * | `100%` on a fixed element (containing block = 1/Z box) | LAYOUT px |
 *
 * VISUAL px = LAYOUT px × Z. At Z = 1.5 a `left: 300px` element renders at
 * visual x = 450, and a pointer at visual x = 300 reports `clientX = 300`.
 *
 * Consequently: the *visible* window in LAYOUT px is
 * `innerWidth / Z × innerHeight / Z` (504 × 312.67 in the example), and any
 * geometry measured in VISUAL px (a pointer position, a trigger's rect) must be
 * divided by `Z` before it is written into `style.left/top` or compared against
 * a measured `offsetWidth/offsetHeight`.
 *
 * The zoom factor is read live through `getUiZoomFactor()` at every call — it
 * is never cached, so a scale change is picked up by the next recompute.
 */

import { getUiZoomFactor } from '@/stores/uiScaleStore'
import type { TriggerRect } from './dropdownPosition'

/** A width/height pair. */
export interface BoxSize {
  width: number
  height: number
}

/**
 * The visible window in LAYOUT px — what a `position: fixed` element's
 * `left/top` and `offsetWidth/offsetHeight` are measured against.
 */
export function getLayoutViewport(zoom: number = getUiZoomFactor()): BoxSize {
  return { width: window.innerWidth / zoom, height: window.innerHeight / zoom }
}

/**
 * Convert a trigger rect measured with `getBoundingClientRect()` (VISUAL px)
 * into LAYOUT px, so it can be combined with offset-px sizes and a
 * {@link getLayoutViewport} extent inside a single positioning computation.
 */
export function toLayoutTriggerRect(
  rect: TriggerRect,
  zoom: number = getUiZoomFactor(),
): TriggerRect {
  return {
    top: rect.top / zoom,
    bottom: rect.bottom / zoom,
    left: rect.left / zoom,
    width: rect.width / zoom,
  }
}
