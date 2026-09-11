import { platform, type Platform } from '@floating-ui/dom'
import { getUiZoomFactor } from '@/stores/uiScaleStore'

/**
 * Zoom compensation for @floating-ui/dom.
 *
 * Why this exists
 * ───────────────
 * The app-wide UI scale is applied as CSS `zoom` on <html>. Under that zoom:
 *   - `getBoundingClientRect()` and pointer `clientX/Y` report VISUAL px
 *     (layout px × zoom factor),
 *   - `style.left/top` on elements inside the zoomed root are written and
 *     interpreted in LAYOUT px.
 * floating-ui measures the reference with `getBoundingClientRect()` and
 * returns those coordinates for the caller to write into `style.left/top` —
 * a visual→layout unit mismatch that displaces every popover/tooltip/menu
 * by exactly `position × (zoom − 1)` (at 150% a popover lands 50% further
 * from its anchor than intended, often outside the viewport).
 *
 * The mismatch cannot be fixed by floating-ui's own scale handling
 * (`getScale`/`includeScale`): for Radix portaled content positioned with
 * `strategy: 'fixed'`, the floating element's offset parent resolves to the
 * Window, and floating-ui's `getBoundingClientRect` helper only applies its
 * scale division when the offset parent is a real element — so the reference
 * rect is never divided.
 *
 * The fix
 * ───────
 * Wrap the geometry-producing methods of the shared `platform` object so the
 * rects they hand to the positioning engine are converted from visual px to
 * layout px (dividing by the zoom factor, read live at call time — never
 * cached):
 *
 *   - `getElementRects` — divide the REFERENCE rect only. The floating side
 *     comes from `getDimensions`, whose `offsetWidth` fallback already
 *     yields layout px.
 *   - `getClippingRect` — divide the returned rect (built from
 *     `html.clientWidth`/`visualViewport`/`getBoundingClientRect`, i.e.
 *     visual px) so overflow/flip/shift math runs in the same layout-px
 *     space.
 *   - `convertOffsetParentRelativeRectToViewportRelativeRect` — deliberately
 *     NOT wrapped: @floating-ui/core only ever feeds it values that are
 *     already in floating-ui's internal (layout-px after the
 *     getElementRects compensation) space — the floating candidate position
 *     or the compensated rects.reference. Dividing its output
 *     double-compensates and makes detectOverflow report phantom overflow
 *     (verified empirically at 70%: popovers dragged ~590 visual px left).
 *   - `getDimensions` — deliberately NOT wrapped: `getCssDimensions` falls
 *     back to `offsetWidth`/`offsetHeight` (layout px) under zoom already.
 *
 * `this` handling matters: `computePosition` builds a per-call copy of the
 * platform (`{...platform, _c: cache}`) and invokes the methods on it, so
 * the stock implementations read their clipping-ancestor cache (`this._c`)
 * and sibling methods (`this.getDimensions`) off that copy. The wrappers
 * below therefore preserve the caller's receiver instead of rebinding it.
 *
 * Mutating the shared `platform` instance is what makes this work for Radix:
 * `@floating-ui/react-dom` re-exports the very same object and reads the
 * method values from it, `@floating-ui/core` middleware read geometry
 * exclusively through the platform, and the package is deduplicated to a
 * single copy in node_modules.
 *
 * At zoom 1.0 every compensation is an identity — the stock result object is
 * returned untouched, so 100% behaves bit-for-bit like stock floating-ui.
 * Installation is idempotent and expected to run once at startup
 * (main.tsx), before any popover opens.
 */

/** Minimal rect shape shared by the wrapped platform methods. */
interface RectLike {
  x: number
  y: number
  width: number
  height: number
}

/** Argument shape of Platform['getElementRects']. */
type ElementRectsArgs = Parameters<Platform['getElementRects']>[0]

/** Result shape of Platform['getElementRects']. */
type ElementRectsResult = {
  reference: RectLike
  floating: RectLike
}

/** Marks a platform method as already wrapped (idempotency flag). */
const COMPENSATED = Symbol('c0wrk-floating-ui-zoom-compensation')

function isCompensated(fn: unknown): boolean {
  return (
    typeof fn === 'function' && (fn as { [COMPENSATED]?: boolean })[COMPENSATED] === true
  )
}

/** Return a copy of `rect` with every coordinate divided by `k`. */
function divideRect<T extends RectLike>(rect: T, k: number): T {
  return {
    ...rect,
    x: rect.x / k,
    y: rect.y / k,
    width: rect.width / k,
    height: rect.height / k,
  }
}

/** Receiver type the wrappers forward to the stock methods (per-call copy). */
type PlatformReceiver = { _c?: Map<unknown, unknown[]> } & Record<string, unknown>

/**
 * Wrap a platform geometry method, preserving the caller's receiver so the
 * stock implementation keeps seeing its per-call `_c` cache and sibling
 * methods. Converts the produced value from visual px to layout px with
 * `compensate(result, zoom)`; at zoom 1 the stock result is returned as-is
 * (same object identity).
 */
function wrapRectMethod<TArgs, TResult extends object>(
  base: (this: PlatformReceiver, args: TArgs) => TResult | Promise<TResult>,
  compensate: (result: TResult, zoom: number) => TResult,
): (this: PlatformReceiver, args: TArgs) => TResult | Promise<TResult> {
  const wrapped = function (
    this: PlatformReceiver,
    args: TArgs,
  ): TResult | Promise<TResult> {
    const result = base.call(this, args)
    const zoom = getUiZoomFactor()
    if (zoom === 1) return result
    return Promise.resolve(result).then((r) => compensate(r, zoom))
  }
  ;(wrapped as { [COMPENSATED]?: boolean })[COMPENSATED] = true
  return wrapped
}

/**
 * Install the zoom compensation on the shared @floating-ui/dom `platform`
 * (or an explicit target — used by tests). Wraps `getElementRects` and
 * `getClippingRect` as described in the module comment; `getDimensions` and
 * `convertOffsetParentRelativeRectToViewportRelativeRect` are left stock.
 * Idempotent: already-wrapped methods are never re-wrapped. Returns the
 * patched platform object.
 */
export function installFloatingUiZoomCompensation(target: Platform = platform): Platform {
  const current = target

  if (!isCompensated(current.getElementRects)) {
    // The cast drops only the parameter type (the receiver type is added by
    // wrapRectMethod); no .bind on purpose: floating-ui's computePosition
    // invokes these methods on a per-call copy ({...platform, _c: cache}),
    // and the stock implementations read that cache and sibling methods off
    // the receiver. The wrapper forwards the caller's receiver so they keep
    // working.
    const base = current.getElementRects as unknown as (
      this: PlatformReceiver,
      args: ElementRectsArgs,
    ) => ElementRectsResult | Promise<ElementRectsResult>
    current.getElementRects = wrapRectMethod(
      base,
      // Divide only the reference rect; the floating side comes from
      // getDimensions and is already layout px.
      (rects, zoom) => ({ ...rects, reference: divideRect(rects.reference, zoom) }),
    ) as unknown as Platform['getElementRects']
  }

  if (!isCompensated(current.getClippingRect)) {
    const base = current.getClippingRect as unknown as (
      this: PlatformReceiver,
      args: never,
    ) => RectLike | Promise<RectLike>
    current.getClippingRect = wrapRectMethod(
      base,
      (rect, zoom) => divideRect(rect, zoom),
    ) as unknown as Platform['getClippingRect']
  }

  // NOTE: convertOffsetParentRelativeRectToViewportRelativeRect is
  // deliberately NOT wrapped. @floating-ui/core feeds it either the floating
  // element's candidate position ({x, y} in floating-ui's internal — after
  // the getElementRects compensation, layout — space) or rects.reference
  // (already compensated layout px). Dividing its output would
  // double-compensate and make detectOverflow report phantom overflow,
  // dragging popovers sideways (verified empirically at 70% zoom: content
  // right edge landed ~590 visual px left of the anchor).

  return current
}
