import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** Lowest supported UI scale, in percent. */
export const UI_SCALE_MIN = 50
/** Highest supported UI scale, in percent. */
export const UI_SCALE_MAX = 200

interface UiScaleState {
  scale: number
}

interface UiScaleActions {
  setScale: (scale: number) => void
}

/** Storage key mirrors the persisted-store convention (c0wrk-*). */
const STORAGE_KEY = 'c0wrk-ui-scale'

/**
 * Clamps the scale to [UI_SCALE_MIN, UI_SCALE_MAX] and rounds it to a whole
 * percent, so fractional or out-of-range input (drags, keyboard steps,
 * third-party callers) collapses to a canonical value before persistence.
 */
function normalizeScale(scale: number): number {
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, scale))
  return Math.round(clamped)
}

/**
 * Writes the zoom factor onto <html> and is a no-op when the document is
 * unavailable (e.g. during tests). Safe to call repeatedly.
 */
export function applyScaleToDocument(scale: number): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.zoom = String(scale / 100)
}

/**
 * Current UI zoom factor (scale / 100), read straight from the store state —
 * usable outside React (event handlers, plain modules like the floating-ui
 * compensation and the pan/zoom hook) without a subscription. Falls back to
 * 1 when the store reports a non-finite/non-positive scale (corrupted
 * persisted state must never divide geometry by garbage).
 */
export function getUiZoomFactor(): number {
  const scale = useUiScaleStore.getState().scale
  if (!Number.isFinite(scale) || scale <= 0) return 1
  return scale / 100
}

/**
 * Notify layout-observing code that the coordinate system changed. A zoom
 * change re-lays-out every element, but no `resize` event fires (the window
 * itself did not change size), so open floating-ui popovers would keep their
 * now-stale positions until the next open. Dispatching a window `resize`
 * triggers floating-ui's `autoUpdate` (which listens on `resize` for open
 * popovers) to recompute with the new geometry. No-op without a window
 * (tests); safe to call repeatedly.
 */
export function dispatchUiResizeNotification(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event('resize'))
}

export const useUiScaleStore = create<UiScaleState & UiScaleActions>()(
  persist(
    (set) => ({
      scale: 100,

      setScale: (scale) => {
        const normalized = normalizeScale(scale)
        applyScaleToDocument(normalized)
        set({ scale: normalized })
        // The zoom just re-laid-out every element without any `resize` event
        // firing; open popovers must recompute against the new geometry.
        dispatchUiResizeNotification()
      },
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      // Bump version and implement migration when adding/removing/renaming persisted fields.
      migrate: (persistedState, _version) => persistedState,
      partialize: (state) => ({ scale: state.scale }),
    },
  ),
)
