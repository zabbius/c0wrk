import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { listThemes, type ThemeInfo } from '@/api/themes'

export type ThemeType = 'dark' | 'light'

/** Descriptor used to resolve a theme's dark/light kind. */
export interface ThemeDescriptor {
  id: string
  name: string
  type: ThemeType
}

/** Built-in themes whose palettes live in index.css (no CSS injection). */
export const BUILTIN_THEMES: readonly ThemeDescriptor[] = [
  { id: 'default-dark', name: 'Default Dark', type: 'dark' },
  { id: 'default-light', name: 'Default Light', type: 'light' },
] as const

const DEFAULT_THEME_ID = 'default-dark'

/** Storage key mirrors the persisted-store convention (c0wrk-*). */
const STORAGE_KEY = 'c0wrk-theme'
/** Attribute written to <html>; built-ins use dark/light, custom themes their id. */
const DATA_THEME_ATTR = 'data-theme'
/** Id of the single <style> element that carries the active custom theme. */
const CUSTOM_THEME_STYLE_ID = 'c0wrk-custom-theme'

/** Coerces a backend theme `type` string to the frontend dark/light union. */
export function themeTypeOf(t: { type: string }): ThemeType {
  return t.type === 'light' ? 'light' : 'dark'
}

function isBuiltinId(id: string): boolean {
  return BUILTIN_THEMES.some((b) => b.id === id)
}

/**
 * Resolves the dark/light kind of a custom theme for the injected
 * `:root{color-scheme:…}` rule. Lookup order: the live store's descriptor
 * (authoritative once loadThemes resolved), then a `color-scheme:` literal
 * inside the cached CSS (covers the pre-paint window in main.tsx before the
 * backend catalog has loaded), then dark.
 */
function resolveCustomThemeType(themeId: string, css: string): ThemeType {
  const custom = useThemeStore?.getState().customThemes.find((t) => t.id === themeId)
  if (custom) return themeTypeOf(custom)
  const m = /color-scheme:\s*(dark|light)/i.exec(css)
  return m ? (m[1]!.toLowerCase() as ThemeType) : 'dark'
}

function removeCustomThemeStyle(): void {
  document.getElementById(CUSTOM_THEME_STYLE_ID)?.remove()
}

/**
 * Applies a theme to the document. Built-in themes write
 * `<html data-theme="dark|light">` and remove the custom-theme style;
 * custom themes write `<html data-theme="<id>">` and inject the theme CSS
 * (plus a `:root{color-scheme:<type>}` suffix) into a single
 * `<style id="c0wrk-custom-theme">` element in <head>. A no-op when the
 * document is unavailable (e.g. during tests).
 */
export function applyThemeToDocument(themeId: string, css: string): void {
  if (typeof document === 'undefined') return
  const builtin = BUILTIN_THEMES.find((b) => b.id === themeId)
  if (builtin) {
    document.documentElement.setAttribute(DATA_THEME_ATTR, builtin.type)
    removeCustomThemeStyle()
    return
  }
  document.documentElement.setAttribute(DATA_THEME_ATTR, themeId)
  let style = document.getElementById(CUSTOM_THEME_STYLE_ID)
  if (!style) {
    style = document.createElement('style')
    style.id = CUSTOM_THEME_STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = `${css}\n:root{color-scheme:${resolveCustomThemeType(themeId, css)}}`
}

interface ThemeState {
  /** Active theme id — a BUILTIN_THEMES id or a custom theme id. */
  themeId: string
  /** Cached CSS of the active custom theme ('' for built-ins). Persisted so
   *  main.tsx can apply the theme before first paint without an RPC. */
  themeCss: string
  /** Installed custom themes. Not persisted — refetched via loadThemes(). */
  customThemes: ThemeInfo[]
}

interface ThemeActions {
  /** Activate a theme and cache its CSS (custom themes only). */
  setTheme: (id: string, css?: string) => void
  /** Replace the custom-theme catalog; resets to Default Dark when the
   *  active custom theme disappears from the list. */
  applyThemes: (list: ThemeInfo[]) => void
  /** Fetch the backend catalog into applyThemes. Safe to call repeatedly. */
  loadThemes: () => Promise<void>
}

export type ThemeStore = ThemeState & ThemeActions

/**
 * Selector helper for consumers that only need the dark/light kind of the
 * active theme (CodeMirror/mermaid/xterm theming). Returns a primitive, so
 * it is referentially stable across renders by construction.
 */
export function selectActiveThemeType(s: Pick<ThemeStore, 'themeId' | 'customThemes'>): ThemeType {
  const builtin = BUILTIN_THEMES.find((b) => b.id === s.themeId)
  if (builtin) return builtin.type
  const custom = s.customThemes.find((t) => t.id === s.themeId)
  return custom ? themeTypeOf(custom) : 'dark'
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      themeId: DEFAULT_THEME_ID,
      themeCss: '',
      customThemes: [],

      setTheme: (id, css) => {
        const current = get()
        // Built-ins have no CSS. A custom theme takes the explicit css
        // argument (the activator knows the theme body); re-selecting the
        // same custom theme without one keeps its cache. Switching to a
        // DIFFERENT custom theme without css cannot reuse the old theme's
        // body — cache stays empty until a css-carrying activation.
        let nextCss: string
        if (isBuiltinId(id)) nextCss = ''
        else if (css !== undefined) nextCss = css
        else if (current.themeId === id) nextCss = current.themeCss
        else nextCss = ''
        applyThemeToDocument(id, nextCss)
        set({ themeId: id, themeCss: nextCss })
      },

      applyThemes: (list) => {
        // Defensive: never let backend data shadow the built-in ids.
        const customs = list.filter((t) => !isBuiltinId(t.id))
        const current = get()
        const activeGone =
          !isBuiltinId(current.themeId) &&
          !customs.some((t) => t.id === current.themeId)
        if (activeGone) {
          // The active custom theme was deleted — fall back to Default Dark
          // and drop the stale CSS cache.
          applyThemeToDocument(DEFAULT_THEME_ID, '')
          set({ customThemes: customs, themeId: DEFAULT_THEME_ID, themeCss: '' })
          return
        }
        set({ customThemes: customs })
        // Re-apply the active custom theme now that its descriptor is known:
        // the pre-paint pass may have sniffed color-scheme from the CSS only.
        if (!isBuiltinId(current.themeId) && current.themeCss) {
          applyThemeToDocument(current.themeId, current.themeCss)
        }
      },

      loadThemes: async () => {
        try {
          get().applyThemes(await listThemes())
        } catch {
          // Backend not ready / unavailable — the built-ins keep working and
          // the caller (App startup) does not surface theme-list errors.
          // listThemes already logged the underlying error.
        }
      },
    }),
    {
      name: STORAGE_KEY,
      version: 2,
      migrate: (persistedState, version) => {
        if (version < 2) {
          // v1 stored { theme: 'dark' | 'light' }.
          const legacy = persistedState as { theme?: unknown } | undefined
          const wasLight =
            !!legacy && typeof legacy === 'object' && legacy.theme === 'light'
          return { themeId: wasLight ? 'default-light' : DEFAULT_THEME_ID, themeCss: '' }
        }
        return persistedState as Pick<ThemeState, 'themeId' | 'themeCss'>
      },
      partialize: (state) => ({ themeId: state.themeId, themeCss: state.themeCss }),
    },
  ),
)
