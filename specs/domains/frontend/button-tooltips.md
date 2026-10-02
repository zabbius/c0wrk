# Button Tooltips

## Role

The convention that guarantees every button in the app exposes its purpose outside its visible label — via a native `title=` attribute or a Radix `<TooltipTrigger>` wrapper — and the project-wide source-scan guard that enforces it.

## Key Files

- `frontend/src/components/ui/tooltip.tsx` — the Radix tooltip primitive: `TooltipProvider` / `Tooltip` / `TooltipTrigger` / `TooltipContent` and `TOOLTIP_DELAY_MS`, the single open-delay constant (1000 ms) shared by the whole UI
- `frontend/src/App.tsx` — mounts one `TooltipProvider` at the app root, so every tooltip in the tree shares the app-wide delay; individual surfaces never re-provide it
- `frontend/src/test/buttonTitleInvariant.test.ts` — the guard: an AST-based scan of the whole non-test source tree that fails when a `<button>` / `<Button>` has neither a `title` attribute nor a `<TooltipTrigger>` ancestor
- `frontend/src/components/layout/ItemAction.tsx` — a native-title-only row-action button (see [row-actions.md](row-actions.md)): the `title` alone satisfies the guard; its disabled reason rides the wrapper span's `title`

## Behavior

### The invariant

Every native `<button>` and shadcn `<Button>` element (including the last segment of a dotted name, `<Tooltip.Button>`) must satisfy **at least one** of:

1. an explicit `title` attribute — any value counts, the attribute's mere presence is the contract (`title="Cancel and stay in c0wrk"`, `title={updatePending ? '…' : '…'}` are both fine); or
2. a `<TooltipTrigger>` JSX ancestor — the Radix wrapper whose whole purpose is to attach the tooltip text. The check walks the JSX parent chain, so conditional children count too: `<TooltipTrigger>{cond && <Button>x</Button>}</TooltipTrigger>`.

A bare button — icon-only or not — leaves a user with no way to learn what it does, which is what the guard exists to prevent. Compliance is a render-time property of the *markup shape*, not of props logic: `title=""` technically passes the guard but is still an empty tooltip, so the text should stay meaningful.

### The context-menu exception (`role="menuitem"`)

Context-menu entries are the one deliberate gap in the invariant: a `<button role="menuitem">` carries **no `title`** — the action is named by the entry's visible text. While the menu is open the pointer already sits on that rendered text, so a hover tooltip could only repeat the label verbatim; the label *is* the explanation. The exemption covers the hand-rolled context menus (`FileViewerContextMenu`, `FileViewerTabContextMenu`, `GitFileContextMenu`, `GitHistoryContextMenu`, `FileTreeContextMenu`), which render their entries as native `<button role="menuitem">`.

The guard applies the exemption before the title check: `hasMenuitemRole` in `frontend/src/test/buttonTitleInvariant.test.ts` reads the element's **own** attribute list and matches only the exact string literal `role="menuitem"`. Keying off the ARIA role — not the file or the component — keeps the gap narrow: a plain button cannot smuggle itself out of the scan by living in a menu file. Everything else still flags:

- `role="menu"` — the container role is not an entry;
- `role={menuItemRole}` — a non-literal role is not provably exempt;
- `data-role="menuitem"` — a different attribute entirely.

A `title` on a menu entry remains accepted (harmless redundancy), but it is not required, and the convention is to omit it.

### Why a button may carry both channels

The native `title` tooltip is rendered by the OS/webview on any element — but **not on a disabled button** in most engines. The Radix tooltip does not have that limitation. A button that can render disabled while hover-explaining itself may therefore carry both channels. `ItemAction` solves the disabled case without Radix: the `disabledReason` is mirrored onto the focusable wrapper span's `title`, so hovering the (inert) button area still shows the reason — see [row-actions.md](row-actions.md). When in doubt about disabled states, either shape works; for a plain enabled button, a `title=` alone is enough.

### The guard test

`buttonTitleInvariant.test.ts` scans every non-test `.ts`/`.tsx` file under `frontend/src/` (same recursive walk pattern as `zoomViewportInvariant.test.ts`, which requires >50 files as a vacuity guard) and parses each with the TypeScript compiler API (`ts.createSourceFile`), so the scan:

- sees only real JSX start/self-closing tags — `<button` in comments, string literals or JSX text can never flag (immunity is by construction, not by comment-stripping heuristics);
- parses `.ts` files as TS (not TSX), so an unparenthesised generic arrow (`<T>(x: T)`) cannot invent a phantom JSX tag;
- walks the JSX parent chain for the `<TooltipTrigger>` ancestor check;
- exempts a button whose own attribute list carries the exact string literal `role="menuitem"` — the context-menu exception documented above, applied before the title check.

Violations are reported as `file:line: snippet`, and the tree-wide assertion fails fast with the full offender list.

The `{...spread}` case is **trusted, fail-open**: a button carrying `{...rest}` passes, because props-forwarding wrappers (`<button {...props}>`) are exactly how a title set at the call site reaches the DOM. Equally fail-open by design: wrapper *components* are out of scope — only intrinsic `button` tags and components named `Button` / `*.Button` are matched (`IconButton`, `DropdownMenuTrigger`, … are beyond the invariant's reach, stopped where a component's own contract begins), and a tooltip from a differently-named wrapper is not recognized.

### Compliant shapes (all accepted by the guard)

```tsx
// 1 — native title
<Button title="Cancel and stay in c0wrk">Cancel</Button>

// 2 — dynamic native title
<Button title={updatePending ? 'Restart now to apply the update' : 'Quit without waiting for sessions'}>
  {updatePending ? 'Restart' : 'Quit'}
</Button>

// 3 — Radix tooltip (works on disabled buttons too)
<Tooltip>
  <TooltipTrigger asChild>
    <button type="button" onClick={f}><Icon /></button>
  </TooltipTrigger>
  <TooltipContent side="left">Copy path</TooltipContent>
</Tooltip>

// 4 — both channels (works on disabled buttons too)
<Tooltip>
  <TooltipTrigger asChild>
    <button title={label} disabled={disabled} onClick={onClick}><Icon /></button>
  </TooltipTrigger>
  <TooltipContent side="left">{label}</TooltipContent>
</Tooltip>

// 5 — native title with the reason on a focusable wrapper (the ItemAction
//     pattern; see row-actions.md — no Radix needed)
<span tabIndex={disabled ? 0 : undefined} title={disabled ? reason : undefined}>
  <button title={disabled ? reason : label} disabled={disabled} onClick={onClick}><Icon /></button>
</span>

// 6 — conditional child inside the trigger still counts
<TooltipTrigger>{ok && <Button>x</Button>}</TooltipTrigger>

// 7 — context-menu entry: the role="menuitem" exemption (no title needed)
<button role="menuitem" onClick={handleClose} className={menuItemClass}>
  <X className="size-4" />
  Close
</button>
```

## Error Handling

The guard is a test-time gate, not runtime code: it fails `npm test` (and therefore CI) with an actionable `file:line: snippet` list. A red run means a newly landed button lacks both channels — fix the button, or rely on one of the documented fail-open passes: the `{...spread}` pass-through (only for a genuine wrapper that forwards `title` from its caller) or the `role="menuitem"` context-menu exemption (only for a real menu entry). There is no runtime fallback: an unannotated button that bypasses the test simply shows no tooltip.

## Invariants

- Every `<button>` / `<Button>` in non-test frontend sources has a `title` attribute or a `<TooltipTrigger>` ancestor — enforced by `frontend/src/test/buttonTitleInvariant.test.ts` on every test run.
- Context-menu entries are the single exception to that invariant: a button with `role="menuitem"` carries no `title` — its visible label is the explanation — and the guard exempts it before the title check.
- The `role="menuitem"` exemption keys off the exact string literal in the element's own attribute list: `role="menu"`, a non-literal `role={…}` and `data-role="menuitem"` still flag, and a `title` on a menu entry stays accepted — all pinned by the guard's self-tests.
- The app mounts exactly one `TooltipProvider`, at the root in `frontend/src/App.tsx`; tooltip open delay is the single constant `TOOLTIP_DELAY_MS` (1000 ms) exported from `frontend/src/components/ui/tooltip.tsx`.
- The guard's comment/string immunity is structural (AST-based), so prose mentioning `<button` never produces false positives.
- `TooltipContent` is always portaled and always carries an `Arrow`; styling stays in the primitive (`text-xs`, token colors) — call sites pass placement (`side`) and content, not chrome.
- A button that can render disabled while hover-explaining itself carries either both channels (native `title` + Radix tooltip), because the native title does not display on disabled elements, or the `ItemAction` wrapper-span pattern (the reason on a focusable span's `title`, see [row-actions.md](row-actions.md)).

## Related Specs

- [README.md](README.md) — frontend architecture overview (this convention's Invariants section)
- [ui-scale.md](ui-scale.md) — the sibling source-scan guard pattern (`zoomViewportInvariant.test.ts`, regex + comment-stripping variant) and zoom-safe geometry rules
