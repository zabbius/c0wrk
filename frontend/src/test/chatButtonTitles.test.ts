// @vitest-environment node
//
// Button-title invariant — scoped to `src/components/chat/**`.
//
// Every button-like element in the chat area carries a native `title=`
// attribute. Chat buttons are frequently icon-only or truncate their label
// (panel section headers, combobox triggers, tool-card bodies), so the native
// tooltip is the only discoverable affordance for hover users — and the
// accessible name for several of them. This guard scans the component tree
// with the real TypeScript parser so a re-introduced untitled button fails
// fast in CI no matter which component it lands in.
//
// Unlike a regex, the parser knows a `<button` in a string literal or a
// comment from a real JSX element, so prose and fixtures cannot produce
// false positives.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import ts from 'typescript'

// This file lives directly under <src>/test/, so '../components/chat'
// resolves to <src>/components/chat.
const CHAT_DIR = fileURLToPath(new URL('../components/chat', import.meta.url))

/** Recursively collect `.tsx` sources (the only files that can carry JSX),
 * excluding test files. */
function collectSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectSources(full))
    } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** Native `<button>` elements, lowercase and capitalized (shadcn/ui). */
const BUTTON_TAGS = new Set(['button', 'Button'])

/**
 * Non-native components that render a `<button>` at their root. Radix
 * `CollapsibleTrigger` renders a native `<button>` (without `asChild`), and
 * chat panel headers collapse through it — so it is held to the same rule.
 */
const BUTTON_RENDERING_COMPONENTS = new Set(['CollapsibleTrigger'])

function isButtonTag(tagName: string): boolean {
  return BUTTON_TAGS.has(tagName) || BUTTON_RENDERING_COMPONENTS.has(tagName)
}

/**
 * Inspect one JSX element's attributes.
 *
 * Returns `'untitled'` when no `title` attribute is present, `'dynamic'` when
 * a `{...spread}` makes the attribute set statically unknowable (skipped —
 * none exist today), and `'ok'` otherwise.
 */
function classifyElement(
  attributes: ts.JsxAttributes,
): 'untitled' | 'dynamic' | 'ok' {
  for (const attr of attributes.properties) {
    if (ts.isJsxSpreadAttribute(attr)) return 'dynamic'
    if (ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.name.escapedText === 'title') {
      return 'ok'
    }
  }
  return 'untitled'
}

/** All untitled button-like JSX elements in `source`, as `line: tag`. */
function findUntitledButtons(
  source: string,
  fileName: string,
): Array<{ line: number; tag: string }> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Array<{ line: number; tag: string }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(sf)
      if (isButtonTag(tag) && classifyElement(node.attributes) === 'untitled') {
        found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, tag })
      }
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return found
}

/** Parse a JSX snippet and report whether a button-like element is flagged. */
function flagsSnippet(snippet: string): boolean {
  return findUntitledButtons(snippet, 'sample.tsx').length > 0
}

describe('button-title guard (chat components)', () => {
  const sources = collectSources(CHAT_DIR)

  it('scans a non-trivial number of component files', () => {
    // Sanity: the walk must actually reach the component tree, otherwise a
    // path regression would make the assertion below vacuously pass.
    expect(sources.length).toBeGreaterThan(30)
  })

  it('gives every button-like element a native title', () => {
    const offenders: string[] = []
    for (const file of sources) {
      for (const { line, tag } of findUntitledButtons(readFileSync(file, 'utf8'), file)) {
        offenders.push(`${relative(CHAT_DIR, file)}:${line}: <${tag}>`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('flags a native button without a title', () => {
    expect(flagsSnippet('<button onClick={f}>Go</button>')).toBe(true)
    expect(flagsSnippet('<button\n  type="button"\n  onClick={f}\n/>')).toBe(true)
  })

  it('passes a button that carries a title (static or bound)', () => {
    expect(flagsSnippet('<button title="Go" onClick={f}>Go</button>')).toBe(false)
    expect(flagsSnippet('<button title={open ? "Collapse" : "Expand"}>x</button>')).toBe(false)
  })

  it('holds capitalized Button and CollapsibleTrigger to the same rule', () => {
    expect(flagsSnippet('<Button size="sm" onClick={f}>Allow</Button>')).toBe(true)
    expect(flagsSnippet('<Button size="sm" title="Allow" onClick={f}>Allow</Button>')).toBe(false)
    expect(flagsSnippet('<CollapsibleTrigger className="x">y</CollapsibleTrigger>')).toBe(true)
    expect(flagsSnippet('<CollapsibleTrigger title="Reasoning">y</CollapsibleTrigger>')).toBe(false)
    // Unrelated components stay out of scope — they may not render a button.
    expect(flagsSnippet('<DialogTrigger>Open</DialogTrigger>')).toBe(false)
  })

  it('skips spread-attribute elements instead of guessing', () => {
    expect(flagsSnippet('<button {...rest}>Go</button>')).toBe(false)
  })

  it('does not flag buttons inside strings or comments', () => {
    expect(flagsSnippet('const s = "<button>not jsx</button>"')).toBe(false)
    expect(flagsSnippet('// <button onClick={f}>comment</button>')).toBe(false)
  })

  it('reports accurate line numbers', () => {
    const src = 'const a = 1\nconst b = 2\nconst c = <button>go</button>\n'
    expect(findUntitledButtons(src, 'sample.tsx')).toEqual([{ line: 3, tag: 'button' }])
  })
})
