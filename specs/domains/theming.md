# Theming

## Purpose

c0wrk ships two built-in themes (Default Dark / One Dark, Default Light / One Light) and lets users import custom CSS themes; a set of ready-to-import bundled palette themes lives in the repo (see "Bundled Themes"). A theme is a set of CSS custom-property (design-token) overrides on `:root`; all component styles reference `var(--color-*)` / `var(--radius-*)` exclusively, so a theme recolors the entire UI — including the embedded terminal (XTerm ANSI mapping) and syntax highlighting — without touching any component code.

## Key Files

- `frontend/src/index.css` - design-token single source of truth: `@theme` block (One Dark defaults) + `[data-theme="light"]` override block (One Light); all component styles cascade from these variables
- `frontend/src/stores/themeStore.ts` - Zustand store (persisted): active `themeId`, CSS cache for the active custom theme, builtin-theme table, `applyThemeToDocument`, `selectActiveThemeType` selector
- `frontend/index.html` - pre-paint anti-FOUC inline script (reads the persisted state from `localStorage['c0wrk-theme']`; under the v2 store shape it is a no-op — the authoritative pre-paint apply lives in `main.tsx`)
- `frontend/src/main.tsx` - pre-paint apply: reads the persisted store synchronously (zustand-persist rehydrates from localStorage synchronously) and applies `data-theme` + injects the cached custom-theme CSS before React renders anything
- `frontend/src/api/themes.ts` - typed RPC wrappers (`listThemes`, `pickAndImportTheme`, `deleteTheme`) over the generated Wails bindings
- `frontend/src/components/settings/ThemeSelector.tsx` - settings UI: theme combobox, import button, hover-delete for custom themes
- `backend/themes.go` - pure theme logic: `ThemeDTO`, `ParseThemeCSS`, `ValidateThemeCSS`, `themeSlug`
- `backend/frontend_api_themes.go` - Wails-exposed methods: `ListThemes`, `ImportThemeFromPath`, `DeleteTheme`
- `desktop/app.go` - `PickAndImportTheme`: native file dialog + import in one action (requires Wails context)
- `backend/config/paths.go` - `ThemesDir(agentDir)` → `<agentDir>/themes` (theme storage root)
- `frontend/src/hooks/useXTermTheme.ts` - resolves XTerm ANSI colors from CSS variables at call time (re-resolves on theme change)
- `frontend/src/lib/cmChatTheme.ts`, `frontend/src/components/fileViewer/CodeMirrorFileViewer.tsx` - CodeMirror themes resolved from CSS variables; re-created via Compartment on theme change
- `specs/assets/example-theme.css` - fully annotated example theme (light, "Solar Light"): a self-contained authoring tutorial — metadata header, validation rules, every token group explained inline; guarded by `TestValidateThemeCSS_SpecExampleTheme`
- `specs/assets/themes/` - bundled palette themes, ready to import as-is (see "Bundled Themes" below); each guarded by `TestValidateThemeCSS_BundledThemes` in `backend/themes_test.go`

## Core Types

```go
// backend/themes.go
type ThemeDTO struct {
    ID   string `json:"id"`
    Name string `json:"name"`
    Type string `json:"type"` // "dark" | "light"
    CSS  string `json:"css"`  // theme body; present on every entry so the
                              // frontend can activate any theme without a
                              // second round-trip
}
```

```ts
// frontend/src/stores/themeStore.ts
interface ThemeState {
    themeId: string           // persisted; builtin id or custom slug, default 'default-dark'
    themeCss: string          // persisted; cached CSS of the active custom theme ('' for builtins)
    customThemes: ThemeInfo[] // NOT persisted; refreshed via loadThemes()
}

interface ThemeActions {
    /** Activate a theme and cache its CSS (custom themes only). Re-selecting
     *  the same custom theme without a css argument keeps the existing cache;
     *  switching to a different custom theme without css clears it. */
    setTheme: (id: string, css?: string) => void
    /** Replace the custom-theme catalog; reset to Default Dark when the
     *  active custom theme disappears from the list. */
    applyThemes: (list: ThemeInfo[]) => void
    /** Fetch the backend catalog into applyThemes. Safe to call repeatedly;
     *  errors are swallowed (builtins keep working when the backend is not
     *  ready). */
    loadThemes: () => Promise<void>
}

export const BUILTIN_THEMES = [
    { id: 'default-dark', name: 'Default Dark', type: 'dark' },
    { id: 'default-light', name: 'Default Light', type: 'light' },
] as const
```

## Flow

```
Import:  [settings: import button] → desktop.PickAndImportTheme()
              → wailsRuntime.OpenFileDialog (filter *.css)
              → backend.ImportThemeFromPath(path)
                   → read file → ValidateThemeCSS → copy into ThemesDir as <slug>.css
                   → ParseThemeCSS → ThemeDTO{id, name, type}
         ← ThemeDTO (incl. the `css` body) → themeStore.setTheme(id, css) → active
           immediately — the CSS body rides with both the import result and
           list entries, so activation never needs a second RPC

Apply:   themeStore.setTheme(id, css)
              → builtin: data-theme = 'dark' | 'light'; remove <style id="c0wrk-custom-theme">
              → custom:  data-theme = <id>; ensure single <style id="c0wrk-custom-theme">
                         in <head> whose textContent = css + ":root{color-scheme:<type>}"

Startup: index.html inline script (blocking, before the CSS <link> applies)
              → reads localStorage['c0wrk-theme']; under the v2 store shape
                (themeId/themeCss) it no-ops (it only understands the legacy
                {theme:"light"|"dark"} shape)
         main.tsx (still before React renders) — the authoritative pre-paint apply:
              → getState() rehydrates synchronously from localStorage
              → applyThemeToDocument(themeId, themeCss): data-theme + cached
                custom CSS injected → correct palette on the very first frame
         App.tsx (after runtime-ready) → loadThemes() → listThemes() →
              applyThemes(list) reconciliation

Delete:  [settings: trash icon on a custom item] → api.deleteTheme(id)
              → backend.DeleteTheme(id) removes <ThemesDir>/<id>.css
              → listThemes() refresh → applyThemes(list)
              → if the deleted theme was active → reset to default-dark + clear CSS cache
```

## Theme File Format

A theme file is a plain UTF-8 CSS file with a `.css` extension. Only CSS custom-property declarations on `:root` (and the metadata header below) are used; custom themes are injected as a single `<style>` element, they are NOT compiled through Tailwind — an `@theme` block in a custom theme is ordinary CSS (the `--color-*` variables still work as plain CSS variables) but the Tailwind-specific `@theme` semantics (utility generation) do not apply.

### Metadata header (required for explicit name/type)

The header comment must open the file (leading whitespace allowed; a `c0wrk-theme` marker anywhere else in the body is ignored):

```css
/* c0wrk-theme: <name> | <dark|light> */
```

- Type matching is case-insensitive (`Dark`, `LIGHT` accepted); the name is free text.
- Without the header, metadata falls back per the chain below.

### Metadata fallback chain

| Priority | Name | Type |
| -------- | ---- | ---- |
| 1 | `/* c0wrk-theme: Name | light */` header (must be at file start) | header type token |
| 2 | prettified filename (`nord.css` → `Nord`; `-`/`_` → spaces, each word capitalized; empty → `Theme`) | `color-scheme: (dark\|light)` declaration in the CSS body (`prefers-color-scheme` media features do NOT count) |
| 3 | — | `dark` (final fallback) |

### Required tokens

A theme MUST declare the two tokens the validator treats as a minimum viable theme:

- `--color-background`
- `--color-foreground`

All other tokens are optional; undeclared tokens keep the One Dark default from `@theme`, so a minimal theme inherits the rest of the palette. (The bundled example theme declares the full set — see the authoring reference below.)

### Validation rules (import gate)

`ValidateThemeCSS` rejects a theme file when:

| # | Rule | Reason |
| - | ---- | ------ |
| 1 | Any `@import` (case-insensitive) | `@import` would pull in network/filesystem resources at injection time |
| 2 | Any `url(...)` whose argument does **not** start with `data:` | Blocks `http(s)://`, protocol-relative `//`, `file:`, and relative URLs — no external fetches, fonts, or tracking beacons |
| 3 | Size > **512 KiB** | Keeps the injected `<style>`, the localStorage cache, and the persisted store small |
| 4 | Missing `--color-background` or `--color-foreground` declaration | Minimum viable theme |

`url(data:...)` (e.g. inline SVG data URIs) is allowed.

### Slug / identity

- The theme ID is derived from the **source filename**: base name without extension, lowercased, restricted to `[a-z0-9-]` with runs of disallowed characters collapsed to single hyphens and edge hyphens trimmed; the result must be non-empty. `My Cool Theme.css` imports as `my-cool-theme.css`, ID `my-cool-theme`.
- The reserved IDs `default-dark` and `default-light` cannot be used by imported themes (no shadowing/aliasing of the builtins).

### Storage

Imported themes live as `~/.c0wrk/themes/<slug>.css` (`config.DefaultAgentDir = ".c0wrk"`; path via `ThemesDir(agentDir)` in `backend/config/paths.go`). The directory is created on demand; listing a missing directory returns an empty list, not an error.

### Re-import semantics (update)

Importing a file whose slug already exists **overwrites** the stored file — re-import is the update path. The theme ID stays stable, so the active selection (`themeId`) and UI ordering survive updates. The new CSS takes effect for the user only after the theme is (re)selected — or immediately, because the settings import flow activates the imported theme right away.

### Deleting the active theme

`DeleteTheme(id)` removes `<ThemesDir>/<id>.css`. If the removed theme is currently active, `applyThemes` reconciles the store: `themeId` resets to `default-dark`, the CSS cache is cleared, and the custom `<style>` element is removed. The UI never keeps pointing at a missing file; there is no confirmation dialog (same one-click pattern as session/project deletion).

## Bundled Themes

Besides the two built-in themes compiled into `index.css`, the repo ships ready-to-import palette themes under `specs/assets/themes/`. They are ordinary custom-theme files: users import them through the same `Settings → Theme → [+]` flow, they land in `~/.c0wrk/themes/<slug>.css`, and they follow every rule of the custom-theme format (header, tokens, validation limits). They exist so users can try known palettes without authoring CSS.

| File | Theme name | Type | Palette |
| ---- | ---------- | ---- | ------- |
| `specs/assets/themes/nord.css` | Nord | dark | Nord |
| `specs/assets/themes/tokyo-night.css` | Tokyo Night | dark | Tokyo Night |
| `specs/assets/themes/catppuccin-mocha.css` | Catppuccin Mocha | dark | Catppuccin (Mocha) |
| `specs/assets/themes/high-contrast-dark.css` | High Contrast Dark | dark | original — black canvas / white text, every pair ≥ WCAG AA (core pairs AAA) |
| `specs/assets/themes/high-contrast-light.css` | High Contrast Light | light | original — white canvas / near-black text, every pair ≥ WCAG AA (core pairs AAA) |
| `specs/assets/themes/catppuccin-latte.css` | Catppuccin Latte | light | Catppuccin (Latte) |
| `specs/assets/themes/rose-pine-dawn.css` | Rosé Pine Dawn | light | Rosé Pine (Dawn) |
| `specs/assets/themes/gruvbox-light.css` | Gruvbox Light | light | Gruvbox (light) |

Notes:

- Each bundled theme declares the full token set (core, surfaces, primary/accent, secondary/muted, semantic, borders, RGB triplets, hljs, terminal, elevation, `color-scheme`) so it is complete without inheriting One Dark defaults.
- `TestValidateThemeCSS_BundledThemes` (`backend/themes_test.go`) guards the whole directory: every file must pass `ValidateThemeCSS`, parse to its declared name/type, and round-trip its filename to its slug. A theme added to the directory must be registered in that test's `bundledThemeFiles` table.
- The two High Contrast themes are original c0wrk palettes (not derived from an external palette); their text/background pairs were measured against WCAG at authoring time.

## Anti-FOUC cache

The persisted store key is `localStorage['c0wrk-theme']`. The custom-theme CSS is cached in the store (`themeCss`) so `main.tsx` can apply the theme — `data-theme` attribute plus `<style id="c0wrk-custom-theme">` injection — **before the first paint**, synchronously from the rehydrated store, without waiting for the Wails bridge or any RPC. The blocking inline script in `index.html` predates the v2 store: it only understands the legacy `{theme: 'light'|'dark'}` shape and is a no-op under v2 — the authoritative pre-paint apply is the `applyThemeToDocument(useThemeStore.getState().themeId, useThemeStore.getState().themeCss)` call at the top of `main.tsx`, which runs before React renders. Store migration: v1 `{theme: 'light'|'dark'}` → v2 `{themeId: 'default-light'|'default-dark', themeCss: ''}`.

The custom-theme type used for the injected `:root{color-scheme:…}` rule resolves in order: (1) the live store's `customThemes` descriptor (authoritative once `loadThemes()` resolved), (2) a `color-scheme: dark|light` literal inside the cached CSS — this covers the pre-paint window in `main.tsx` before the backend catalog has loaded —, (3) `dark`.

## Token Reference (authoring)

Single source of truth: the `@theme` block in `frontend/src/index.css`. A custom theme should declare overrides on `:root`. Complete token list (with One Dark defaults):

| Group | Token | Default (One Dark) |
| ----- | ----- | ------------------ |
| Core | `--color-background` | `#282c34` |
| Core | `--color-foreground` | `#abb2bf` |
| Surfaces | `--color-card` | `#252931` |
| Surfaces | `--color-card-foreground` | `#abb2bf` |
| Surfaces | `--color-popover` | `#252931` |
| Surfaces | `--color-popover-foreground` | `#abb2bf` |
| Primary/Accent | `--color-primary` | `#abb2bf` |
| Primary/Accent | `--color-primary-foreground` | `#282c34` |
| Primary/Accent | `--color-accent` | `#abb2bf` |
| Primary/Accent | `--color-accent-foreground` | `#282c34` |
| Secondary/Muted | `--color-secondary` | `#1d2025` |
| Secondary/Muted | `--color-secondary-foreground` | `#cccccc` |
| Secondary/Muted | `--color-muted` | `#1d2025` |
| Secondary/Muted | `--color-muted-foreground` | `#cccccc` |
| Semantic | `--color-destructive` | `#e06c75` |
| Semantic | `--color-destructive-foreground` | `#282c34` |
| Semantic | `--color-success` | `#98c379` |
| Semantic | `--color-warning` | `#d19a66` |
| Semantic | `--color-info` | `#61afef` |
| Semantic | `--color-highlight` | `#e5c07b` |
| Borders/Inputs | `--color-border` | `#1d2025` |
| Borders/Inputs | `--color-input` | `#1d2025` |
| Borders/Inputs | `--color-ring` | `#abb2bf` |
| RGB triplets | `--color-primary-rgb` | `82, 139, 255` |
| RGB triplets | `--color-success-rgb` | `152, 195, 121` |
| RGB triplets | `--color-destructive-rgb` | `224, 108, 117` |
| hljs | `--color-hljs-comment` | `#5c6370` |
| hljs | `--color-hljs-keyword` | `#c678dd` |
| hljs | `--color-hljs-literal` | `#56b6c2` |
| Terminal | `--color-terminal-cursor` | `#528bff` |
| Terminal | `--color-terminal-selection` | `#3e4451` |
| Terminal | `--color-terminal-bright-white` | `#ffffff` |
| Elevation | `--color-shadow` | `rgba(0, 0, 0, 0.3)` |
| Radii | `--radius-sm` / `--radius-md` / `--radius-lg` / `--radius-xl` | `0.25rem` / `0.375rem` / `0.5rem` / `0.75rem` |

Notes for authors:

- `--color-*-rgb` triplets (comma-separated `r, g, b`) feed `rgba()` usage; keep them in sync with their base colors.
- `--color-shadow` is adaptive per theme (softer on light backgrounds).
- The embedded terminal maps ANSI colors onto these tokens (see `frontend/src/hooks/useXTermTheme.ts`): background ← `--color-popover`, black ← `--color-background`, red ← `--color-destructive`, green ← `--color-success`, yellow ← `--color-highlight`, blue ← `--color-info`, magenta ← `--color-hljs-keyword`, cyan ← `--color-hljs-literal`, white ← `--color-foreground`, brightBlack ← `--color-hljs-comment`, brightWhite ← `--color-terminal-bright-white`.
- CodeMirror editor themes are resolved from the same variables and re-created via Compartment on theme change.
- A complete, annotated starter theme with inline authoring guidance: [example-theme.css](../assets/example-theme.css) (type `light`).

## UX

The design target (settings → Appearance): a combobox lists **Default Dark** and **Default Light** (builtin; Moon/Sun type icons) separated from custom themes. Every item shows its type icon; the active item carries a check. Custom items expose a trash icon in a hover overlay (the `ItemAction` pattern used by the session/project lists) — one click deletes, no confirmation; deleting the active theme falls back to Default Dark automatically. Next to the combobox, an import button opens the native `.css` file picker; a successful import adds the theme to the list and activates it immediately; canceling the picker changes nothing.

Current state: the full design above has landed — backend storage + validation (`backend/themes.go`), the three RPCs (`backend/frontend_api_themes.go`), the native picker bridge (`desktop/app.go` `PickAndImportTheme`), the API wrappers (`frontend/src/api/themes.ts`), the themeStore v2 (`frontend/src/stores/themeStore.ts`), and the settings surface itself (`frontend/src/components/settings/ThemeSelector.tsx` — combobox + import button + hover-delete via `ThemeMenuItem`).

## Invariants

- All UI colors come from design tokens; components never hardcode hex values. A theme is exactly a set of token overrides — never component CSS overrides.
- `--color-background` and `--color-foreground` are always defined for every theme (validator-enforced minimum).
- No theme ever triggers a network or filesystem fetch: `@import` and non-`data:` `url(...)` are rejected at import.
- A theme file is at most 512 KiB.
- Custom theme IDs are lowercase `[a-z0-9-]+` and never collide with `default-dark` / `default-light`.
- At most one `<style id="c0wrk-custom-theme">` element exists in `<head>`; builtins remove it.
- The active theme is applied before first paint (`main.tsx` synchronous apply from the rehydrated store) — no flash of the wrong theme.
- The store never points at a missing theme file: when the active theme disappears, the store resets to `default-dark` and clears the CSS cache.
- The terminal, CodeMirror, and highlight.js palettes follow the active theme automatically because they resolve CSS variables at call time.
