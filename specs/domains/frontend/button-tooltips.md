# Button Tooltips

## Role

The convention that guarantees every button in the app exposes its purpose to a user who cannot read its visible label — via a native `title=` attribute, a Radix `<TooltipTrigger>` wrapper, or its own always-visible label — and the project-wide source-scan guard that enforces it. Buttons whose markup may hide the label (responsive collapse into an icon-only state) always carry a `title`; buttons whose label always shows need none.

## Key Files

- `frontend/src/components/ui/tooltip.tsx` — the Radix tooltip primitive: `TooltipProvider` / `Tooltip` / `TooltipTrigger` / `TooltipContent` and `TOOLTIP_DELAY_MS`, the single open-delay constant (1000 ms) shared by the whole UI
- `frontend/src/App.tsx` — mounts one `TooltipProvider` at the app root, so every tooltip in the tree shares the app-wide delay; individual surfaces never re-provide it
- `frontend/src/test/buttonTitleInvariant.test.ts` — the guard: an AST-based scan of the whole non-test source tree that fails when a `<button>` / `<Button>` has neither a `title` attribute, a `<TooltipTrigger>` ancestor, nor a statically visible label
- `frontend/src/components/layout/ItemAction.tsx` — a native-title-only row-action button (see [row-actions.md](row-actions.md)): the `title` alone satisfies the guard; its disabled reason rides the wrapper span's `title`
- `frontend/src/components/ui/segmented-control.tsx` — the pinned label-hiding surface: segments may hide their string label responsively (`labelClassName="hidden …:inline"`), so the control derives each item's `title` from its string label automatically (`item.title` overrides)

## Behavior

### The invariant

Every native `<button>` and shadcn `<Button>` element (including the last segment of a dotted name, `<Tooltip.Button>`) must satisfy **at least one** of:

1. an explicit `title` attribute — any value counts, the attribute's mere presence is the contract (`title={updatePending ? '…' : '…'}` is fine); or
2. a `<TooltipTrigger>` JSX ancestor — the Radix wrapper whose whole purpose is to attach the tooltip text. The check walks the JSX parent chain, so conditional children count too: `<TooltipTrigger>{cond && <Button>x</Button>}</TooltipTrigger>`; or
3. a **statically visible label** — JSX text inside the element, or an expression proven to render a non-empty string (`{saving ? 'Saving…' : 'Save'}`, nested ternaries included). The label IS the explanation, so a tooltip over always-labeled text can only echo it — an **echo `title` on a button whose label always shows is the anti-pattern this channel removes**.

The three channels answer different visibility regimes:

- **The label may hide** (responsive collapse `hidden @min-[…]:inline`, overflow truncation, a later redesign into icon-only) — the `title` is REQUIRED regardless of what the source shows, because at the moment it hides, the tooltip becomes the only name the button has. The guard cannot see CSS, so this obligation is enforced at review time: markup that hides its label and relies on the static-label channel is a review defect even though the guard accepts it.
- **The label always shows** — the `title` is NOT needed; write one only when it adds information the label lacks (the selector-trigger rule below), never as an echo.

`title=""` technically passes the guard but is still an empty tooltip, so the text should stay meaningful.

### The context-menu exception (`role="menuitem"`)

Context-menu entries are the one deliberate gap in the invariant: a `<button role="menuitem">` carries **no `title`** — the action is named by the entry's visible text. While the menu is open the pointer already sits on that rendered text, so a hover tooltip could only repeat the label verbatim; the label *is* the explanation. The exemption covers the hand-rolled context menus (`FileViewerContextMenu`, `FileViewerTabContextMenu`, `GitFileContextMenu`, `GitHistoryContextMenu`, `FileTreeContextMenu`), which render their entries as native `<button role="menuitem">`.

The guard applies the exemption before the title check: `hasMenuitemRole` in `frontend/src/test/buttonTitleInvariant.test.ts` reads the element's **own** attribute list and matches only the exact string literal `role="menuitem"`. Keying off the ARIA role — not the file or the component — keeps the gap narrow: a plain button cannot smuggle itself out of the scan by living in a menu file. Everything else still flags:

- `role="menu"` — the container role is not an entry;
- `role={menuItemRole}` — a non-literal role is not provably exempt;
- `data-role="menuitem"` — a different attribute entirely.

A `title` on a menu entry remains accepted (harmless redundancy), but it is not required, and the convention is to omit it.

### The selector-trigger rule (the title names the action, not the value)

A picker trigger — the `DropdownMenuTrigger`/`PopoverTrigger` button of a selector — shows the **currently-selected value as its visible label**, and the same values are listed inside the open menu. Its `title` must **add information the on-screen label does not carry**, never echo the selection verbatim: `Switch project`, `Switch session`, `Select model profile`, `Switch theme` name the action the control performs; `Embedded: Bonsai 2 27B` over the bare label `Bonsai 2 27B` adds the provider. A value-echoing tooltip (`title={activeProject?.name}`, a restatement of the truncated display label) adds nothing over the on-screen text — on a long label clipped by a narrow sidebar it merely repeats the same string — and is the anti-pattern this rule bans.

State-dependent title branches on a picker trigger stay allowed when each branch either names an action, adds information, or gives a real hover hint (`isLoading ? 'Loading models…' : disabled ? 'Locked while the session is running' : effectiveEntry ? \`${providerLabel}: ${model}\` : displayLabel` in `ModelPickerMenu`) — the rule bans echoing the *value*, not conditionality.

This is a content rule, beyond the AST guard's reach: the guard verifies that a title exists, not what it says. Compliance is enforced at review time; the pinned example is the `ModelPickerMenu` test asserting the trigger title is exactly `Embedded: Bonsai 2 27B` for the embedded selection whose visible label is the bare `Bonsai 2 27B` — the enrich case, not an echo.

### Why a button may carry both channels

The native `title` tooltip is rendered by the OS/webview on any element — but **not on a disabled button** in most engines. The Radix tooltip does not have that limitation. A button that can render disabled while hover-explaining itself may therefore carry both channels. `ItemAction` solves the disabled case without Radix: the `disabledReason` is mirrored onto the focusable wrapper span's `title`, so hovering the (inert) button area still shows the reason — see [row-actions.md](row-actions.md). When in doubt about disabled states, either shape works; for a plain enabled button, a `title=` alone is enough.

### The guard test

`buttonTitleInvariant.test.ts` scans every non-test `.ts`/`.tsx` file under `frontend/src/` (same recursive walk pattern as `zoomViewportInvariant.test.ts`, which requires >50 files as a vacuity guard) and parses each with the TypeScript compiler API (`ts.createSourceFile`), so the scan:

- sees only real JSX start/self-closing tags — `<button` in comments, string literals or JSX text can never flag (immunity is by construction, not by comment-stripping heuristics);
- parses `.ts` files as TS (not TSX), so an unparenthesised generic arrow (`<T>(x: T)`) cannot invent a phantom JSX tag;
- walks the JSX parent chain for the `<TooltipTrigger>` ancestor check;
- accepts the static-label channel: a paired element's own JSX text and provable expressions (`isStaticString` — string literals, parenthesized literals, and nested ternaries with all-literal leaves). Only the element's OWN children count — a sibling element's text never labels a self-closing button;
- exempts a button whose own attribute list carries the exact string literal `role="menuitem"` — the context-menu exception documented above, applied before the title check.

The static-label proof is deliberately conservative: an identifier — even a lookup in a `const` table (`{NAME_LABELS[kind].action}`) — is not provable and keeps the title requirement. A label that needs the guard's acceptance must be written as literal text or an all-literal ternary in the JSX; when a static table is the cleaner source of truth for the data, render the string through a literal ternary at the use site.

Violations are reported as `file:line: snippet`, and the tree-wide assertion fails fast with the full offender list.

The `{...spread}` case is **trusted, fail-open**: a button carrying `{...rest}` passes, because props-forwarding wrappers (`<button {...props}>`) are exactly how a title set at the call site reaches the DOM. Equally fail-open by design: wrapper *components* are out of scope — only intrinsic `button` tags and components named `Button` / `*.Button` are matched (`IconButton`, `DropdownMenuTrigger`, … are beyond the invariant's reach, stopped where a component's own contract begins), a tooltip from a differently-named wrapper is not recognized, and a CSS-hidden label fools the static-label acceptance (the review-time rule above is the counterweight).

### Compliant shapes (all accepted by the guard)

```tsx
// 1 — icon-only: native title REQUIRED (the label cannot explain anything)
<Button title="Cancel and stay in c0wrk"><X /></Button>

// 2 — static visible label: NO title — the label IS the explanation
<Button variant="outline" onClick={close}>Cancel</Button>
<Button onClick={save} disabled={isSaving}>{isSaving ? 'Saving...' : 'Save'}</Button>

// 3 — dynamic text: title REQUIRED (the guard cannot prove the label)
<Button title={dynamicTitle}>ok</Button>

// 4 — Radix tooltip (works on disabled buttons too)
<Tooltip>
  <TooltipTrigger asChild>
    <button type="button" onClick={f}><Icon /></button>
  </TooltipTrigger>
  <TooltipContent side="left">Copy path</TooltipContent>
</Tooltip>

// 5 — both channels (works on disabled buttons too)
<Tooltip>
  <TooltipTrigger asChild>
    <button title={label} disabled={disabled} onClick={onClick}><Icon /></button>
  </TooltipTrigger>
  <TooltipContent side="left">{label}</TooltipContent>
</Tooltip>

// 6 — native title with the reason on a focusable wrapper (the ItemAction
//     pattern; see row-actions.md — no Radix needed)
<span tabIndex={disabled ? 0 : undefined} title={disabled ? reason : undefined}>
  <button title={disabled ? reason : label} disabled={disabled} onClick={onClick}><Icon /></button>
</span>

// 7 — conditional child inside the trigger still counts
<TooltipTrigger>{ok && <Button>x</Button>}</TooltipTrigger>

// 8 — context-menu entry: the role="menuitem" exemption (no title needed)
<button role="menuitem" onClick={handleClose} className={menuItemClass}>
  <X className="size-4" />
  Close
</button>

// 9 — MAY-HIDE label: title REQUIRED even though the label is in the source
//     (responsive collapse to icon-only — the SegmentedControl pattern; the
//     control derives this title from the string label automatically)
<SegmentedControl
  items={[{ value: 'files', icon: <FolderTree />, label: 'Files' }]}
  labelClassName="hidden @min-[272px]:inline"
/>

// 10 — may-hide label kept in a data table: render it through a literal
//      ternary so the guard proves the label without an echo title
<Button>{busy ? 'Saving…' : kind === 'duplicate' ? 'Duplicate' : 'Rename'}</Button>
```

## Error Handling

The guard is a test-time gate, not runtime code: it fails `npm test` (and therefore CI) with an actionable `file:line: snippet` list. A red run means a newly landed button has none of the three channels — give an icon-only button a `title`, let an always-labeled button's text speak for itself (write it as JSX text or an all-literal ternary), or rely on one of the documented fail-open passes: the `{...spread}` pass-through (only for a genuine wrapper that forwards `title` from its caller) or the `role="menuitem"` context-menu exemption (only for a real menu entry). There is no runtime fallback: a button that bypasses the test and can hide its label simply shows no tooltip in its icon-only state.

## Invariants

- Every `<button>` / `<Button>` in non-test frontend sources exposes its purpose via at least one of the three channels — a `title` attribute, a `<TooltipTrigger>` ancestor, or a statically visible label — enforced by `frontend/src/test/buttonTitleInvariant.test.ts` on every test run. The chat-scoped `frontend/src/test/chatButtonTitles.test.ts` additionally holds `CollapsibleTrigger` to the same rule.
- A button whose markup may hide its label (responsive collapse into an icon-only state, truncation to the point of loss) carries a `title` regardless of the label's presence in the source — at the moment the label hides, the tooltip is the only name the button has. The guard cannot verify visibility, so this obligation is enforced at review time; `SegmentedControl` is the pinned compliant surface (it derives each item's `title` from its string label automatically).
- A button whose label always shows carries no echo `title` — its label is the explanation, and a tooltip repeating it verbatim adds nothing. The static-label channel accepts the button; writing `title="Cancel"` over the label `Cancel` is the anti-pattern this convention removed from `CreateProjectDialog`, `MCPServerForm`, `ModelConfigDialog`, `ModelProfileDialog`, `MCPSettings`, `MCPServerCard`, `UpdateSettings`, `UpdateToast`, `SessionActionConfirmDialog`, `UserConfirmDangerDialog`, `ModelProfilesSettings`, `SecuritySettings`, `FileTreePanel`, `EmbeddedLLM*`, `ui/dialog`, and `LLMSettings` (text Cancel). `ui/dialog`'s footer Close is the pinned echo example.
- A picker trigger's `title` adds information the visible label does not carry — an action name (`Switch project`) or an enrichment (`Provider: Model` over the bare model label) — and never echoes the label verbatim (`title={activeProject?.name}` is the anti-pattern). The guard cannot verify wording — this rule is enforced at review time, with `ModelPickerMenu`'s "the title is exactly `Embedded: Bonsai 2 27B` over the bare `Bonsai 2 27B` label" test as the pinned enrich example.
- The static-label proof is deliberately conservative: only JSX text and all-literal (nested) ternaries are provable; identifiers and expressions keep the title requirement — a label meant for the static channel is written as literal text or a literal ternary at the use site. The check reads a paired element's OWN children only: a sibling element's text never labels a self-closing button.
- The `role="menuitem"` exemption keys off the exact string literal in the element's own attribute list: `role="menu"`, a non-literal `role={…}` and `data-role="menuitem"` still flag, and a `title` on a menu entry stays accepted — all pinned by the guard's self-tests.
- The app mounts exactly one `TooltipProvider`, at the root in `frontend/src/App.tsx`; tooltip open delay is the single constant `TOOLTIP_DELAY_MS` (1000 ms) exported from `frontend/src/components/ui/tooltip.tsx`.
- The guard's comment/string immunity is structural (AST-based), so prose mentioning `<button` never produces false positives.
- `TooltipContent` is always portaled and always carries an `Arrow`; styling stays in the primitive (`text-xs`, token colors) — call sites pass placement (`side`) and content, not chrome.
- A button that can render disabled while hover-explaining itself carries either both channels (native `title` + Radix tooltip), because the native title does not display on disabled elements, or the `ItemAction` wrapper-span pattern (the reason on a focusable span's `title`, see [row-actions.md](row-actions.md)).

## Related Specs

- [README.md](README.md) — frontend architecture overview (this convention's Invariants section)
- [ui-scale.md](ui-scale.md) — the sibling source-scan guard pattern (`zoomViewportInvariant.test.ts`, regex + comment-stripping variant) and zoom-safe geometry rules
