// @vitest-environment node
//
// Type-scale invariant — project-wide guard.
//
// Font sizes are tokenized: the `text-*` utilities resolve from the px-valued
// `--text-*` tokens in the `@theme` block of `index.css` (the single source of
// truth), and font families from `--font-sans`/`--font-mono`/`--font-icon`
// (with a TS mirror in `lib/fonts.ts` for non-CSS consumers: CodeMirror 6
// themes and the xterm constructor need a literal stack string).
//
// Two regressions are guarded here:
//
// 1. Arbitrary px/rem font-size utilities (`text-[10px]`, `text-[0.75rem]`)
//    bypass the scale — they are how the pre-tokenization UI accumulated ten
//    different sizes. Sizes must go through the named scale; only COLOR
//    arbitrary values (`text-[var(--color-*]`, `text-[color-mix(…)]`) are
//    legal in the `text-[…]` slot. (CSS font-size literals are governed by
//    review, not this scan: `@theme` itself and the `html` base legitimately
//    carry px values, and per-component CSS files are not a pattern here.)
//
// 2. Hardcoded font-family stacks outside the token definitions — the same
//    duplication the tokenization removed (four mono + two sans copies).
//    CSS may only use `var(--font-*)` (plus the `@font-face` declaration
//    itself); TS may only reference the `FONT_*_STACK` constants from
//    `lib/fonts.ts` (or a `var(--font-…)` string).

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
// The real TS parser is used to identify comments: unlike a regex or a
// hand-rolled scanner it knows which `//`/`/*` sequences are comments and which
// are string, regex or JSX-text content. Same approach as
// zoomViewportInvariant.test.ts.
import ts from 'typescript'

// This file lives directly under <src>/test/, so '..' resolves to <src>/.
const SRC_DIR = fileURLToPath(new URL('..', import.meta.url))

/** Recursively collect `.ts`/`.tsx` sources, excluding test files. */
function collectSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectSources(full))
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** Recursively collect `.css` files (index.css + assets/themes/*). */
function collectStylesheets(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectStylesheets(full))
    } else if (entry.name.endsWith('.css')) {
      out.push(full)
    }
  }
  return out
}

/** Offsets of every REAL comment in `source`, as the TypeScript parser sees
 * them (see zoomViewportInvariant.test.ts for the full rationale: strings,
 * regex literals and JSX text must keep being scanned). */
function commentRanges(
  source: string,
  fileName: string,
  kind: ts.ScriptKind,
): Array<readonly [number, number]> {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    kind,
  )
  const ranges: Array<readonly [number, number]> = []
  const add = (rs: readonly ts.CommentRange[] | undefined): void => {
    if (rs) for (const r of rs) ranges.push([r.pos, r.end])
  }
  const visit = (node: ts.Node): void => {
    add(ts.getLeadingCommentRanges(source, node.pos))
    for (const child of node.getChildren(sf)) visit(child)
    add(ts.getTrailingCommentRanges(source, node.end))
  }
  visit(sf)
  return ranges
}

/** Blank every comment span (newlines kept) so code is scanned while comment
 * prose is not. Offsets and line structure are preserved exactly. */
function stripComments(source: string, fileName: string): string {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const ranges = [...commentRanges(source, fileName, kind)].sort((a, b) => a[0] - b[0])
  let out = ''
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start < cursor) continue
    out += source.slice(cursor, start)
    out += source.slice(start, end).replace(/[^\n]/g, ' ')
    cursor = end
  }
  return out + source.slice(cursor)
}

/** An arbitrary font-size utility: `text-[10px]`, `text-[0.75rem]`, …
 * Color arbitrary values (`text-[var(--color-x)]`, `text-[color-mix(…)]`)
 * contain no px/rem length and do not match. */
const PX_FONT_SIZE = /text-\[\d+(?:\.\d+)?(?:px|rem)\]/

/** A hardcoded font-family stack in TS: `fontFamily: 'ui-monospace, …'`.
 * Token constants (`fontFamily: FONT_MONO_STACK`) and `var()` references do
 * not match — the value must be a quoted string literal. */
const TS_RAW_FONT_FAMILY = /fontFamily\s*:\s*(['"`])((?!\1).+)\1/

/** A `font-family:` declaration value in CSS, captured to the terminator.
 * Global: `matchAll` requires it. */
const CSS_FONT_FAMILY = /font-family\s*:\s*([^;]+);/g

/** Spans of every `@font-face { … }` block, whose own `font-family:` names
 * the face being declared and is therefore legitimate. */
function fontFaceRanges(css: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = []
  for (const m of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
    ranges.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
  }
  return ranges
}

/** Is this CSS `font-family` value legal? Only `var(--font-*)` references are;
 * inside `@font-face` the literal face name is the declaration itself. */
function isLegalCssFontFamily(value: string, inFontFace: boolean): boolean {
  if (inFontFace) return true
  return value.trim().startsWith('var(--font-')
}

describe('type-scale guard (typography token invariant)', () => {
  const sources = collectSources(SRC_DIR)
  const stylesheets = collectStylesheets(SRC_DIR)

  it('scans a non-trivial number of source and stylesheet files', () => {
    expect(sources.length).toBeGreaterThan(50)
    expect(stylesheets.length).toBeGreaterThan(5)
  })

  it('defines the type-scale and font-family tokens in @theme', () => {
    const css = readFileSync(join(SRC_DIR, 'index.css'), 'utf8')
    expect(css).toMatch(/--text-xs:\s*12px/)
    expect(css).toMatch(/--text-sm:\s*14px/)
    expect(css).toMatch(/--text-base:\s*16px/)
    expect(css).toMatch(/--text-lg:\s*18px/)
    expect(css).toMatch(/--font-sans:/)
    expect(css).toMatch(/--font-mono:/)
    expect(css).toMatch(/--font-icon:/)
  })

  it('never sizes text with an arbitrary px/rem utility', () => {
    const offenders: string[] = []
    for (const file of sources) {
      const lines = stripComments(readFileSync(file, 'utf8'), file).split('\n')
      lines.forEach((line, i) => {
        if (PX_FONT_SIZE.test(line)) {
          offenders.push(`${relative(SRC_DIR, file)}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('never hardcodes a font-family stack in TS outside lib/fonts.ts', () => {
    const offenders: string[] = []
    for (const file of sources) {
      if (file.endsWith(join('lib', 'fonts.ts'))) continue // the TS mirror itself
      const lines = stripComments(readFileSync(file, 'utf8'), file).split('\n')
      lines.forEach((line, i) => {
        const m = TS_RAW_FONT_FAMILY.exec(line)
        const stack = m?.[2]
        if (stack !== undefined && !stack.trim().startsWith('var(--font-')) {
          offenders.push(`${relative(SRC_DIR, file)}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('never hardcodes a font-family stack in CSS outside @font-face', () => {
    const offenders: string[] = []
    for (const file of stylesheets) {
      const css = readFileSync(file, 'utf8')
      const faceRanges = fontFaceRanges(css)
      const inFace = (pos: number): boolean =>
        faceRanges.some(([s, e]) => pos >= s && pos < e)
      for (const m of css.matchAll(CSS_FONT_FAMILY)) {
        const value = m[1]
        if (value !== undefined && !isLegalCssFontFamily(value, inFace(m.index ?? 0))) {
          const line = css.slice(0, m.index ?? 0).split('\n').length
          offenders.push(`${relative(SRC_DIR, file)}:${line}: ${m[0].trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the px-size pattern catches font sizes but not color values', () => {
    expect(PX_FONT_SIZE.test('className="text-[10px]"')).toBe(true)
    expect(PX_FONT_SIZE.test('className="sm:text-[11px]"')).toBe(true)
    expect(PX_FONT_SIZE.test('className="text-[0.75rem]"')).toBe(true)
    expect(PX_FONT_SIZE.test('className="text-[var(--color-highlight)]"')).toBe(false)
    expect(
      PX_FONT_SIZE.test('className="text-[color-mix(in_srgb,var(--color-foreground)_50%,transparent)]"'),
    ).toBe(false)
    // Other size utilities with px values (padding etc.) are not text sizes.
    expect(PX_FONT_SIZE.test('className="p-[10px] text-xs"')).toBe(false)
  })

  it('the TS font-family pattern catches stacks but not token references', () => {
    expect(TS_RAW_FONT_FAMILY.test("fontFamily: 'ui-monospace, Menlo, monospace'")).toBe(true)
    expect(TS_RAW_FONT_FAMILY.test('fontFamily: "ui-sans-serif, system-ui, sans-serif"')).toBe(true)
    // Token constant and var() references stay unflagged.
    expect(TS_RAW_FONT_FAMILY.test('fontFamily: FONT_MONO_STACK')).toBe(false)
    expect(TS_RAW_FONT_FAMILY.test("fontFamily: 'var(--font-mono)'")).toBe(true) // caught…
    // …unless the var() exemption applies (the scan itself checks the prefix).
    expect("var(--font-mono)".trim().startsWith('var(--font-')).toBe(true)
  })

  it('the CSS font-family check exempts @font-face and accepts only var(--font-*)', () => {
    const face = '@font-face {\n  font-family: "SauceCodePro NF";\n  src: url(x.ttf);\n}'
    expect(fontFaceRanges(face)).toHaveLength(1)
    expect(isLegalCssFontFamily('"SauceCodePro NF"', true)).toBe(true)
    expect(isLegalCssFontFamily('var(--font-mono)', false)).toBe(true)
    expect(isLegalCssFontFamily('ui-monospace, monospace', false)).toBe(false)
    expect(isLegalCssFontFamily('"SauceCodePro NF", monospace', false)).toBe(false)
  })
})
