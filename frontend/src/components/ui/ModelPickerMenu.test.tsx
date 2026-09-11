// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { ModelPickerMenu } from './ModelPickerMenu'
import type { ModelRef } from '@/lib/modelId'

const models: ModelRef[] = [
  { name: 'claude-sonnet', provider: 'anthropic' },
  { name: 'glm-5.3', provider: 'lmstudio' },
]

let container: HTMLDivElement
let root: Root
let onSelect: Mock<(id: string | null) => void>

function renderMenu(props: Partial<Parameters<typeof ModelPickerMenu>[0]> = {}): void {
  act(() => {
    root.render(
      <ModelPickerMenu
        ariaLabel="Pick a model"
        models={models}
        defaultModel="anthropic/claude-sonnet"
        loaded
        value={null}
        onSelect={onSelect}
        {...props}
      />,
    )
  })
}

function trigger(): HTMLButtonElement {
  const btn = container.querySelector('button[aria-label="Pick a model"]') as HTMLButtonElement | null
  expect(btn).not.toBeNull()
  return btn!
}

function openByClick(): void {
  act(() => {
    trigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function listbox(): HTMLDivElement {
  const el = document.querySelector('[role="listbox"]')
  expect(el).not.toBeNull()
  return el as HTMLDivElement
}

function options(): HTMLButtonElement[] {
  return Array.from(listbox().querySelectorAll<HTMLButtonElement>('[role="option"]'))
}

function pressKey(el: Element, key: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

beforeEach(() => {
  onSelect = vi.fn<(id: string | null) => void>()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ModelPickerMenu listbox semantics', () => {
  it('exposes entries as role=option with aria-selected, grouped in aria-labelled groups', () => {
    renderMenu()

    openByClick()

    const optionsInMenu = options()
    // "Default" entry + one option per model.
    expect(optionsInMenu).toHaveLength(3)

    const [defaultOpt, anthropicOpt, lmstudioOpt] = optionsInMenu
    expect(defaultOpt!.getAttribute('aria-selected')).toBe('true')
    expect(anthropicOpt!.getAttribute('aria-selected')).toBe('false')
    expect(lmstudioOpt!.getAttribute('aria-selected')).toBe('false')

    // The listbox is labelled; provider groups are exposed as labelled
    // groups (valid listbox → group → option ownership); visual headers are
    // aria-hidden so they are not announced twice.
    expect(listbox().getAttribute('aria-label')).toBe('Pick a model')
    const groups = Array.from(listbox().querySelectorAll('[role="group"]'))
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Anthropic', 'lmstudio'])
    expect(listbox().querySelectorAll('[aria-hidden="true"]')).toHaveLength(2)
  })

  it('marks the selected composite id as the single aria-selected option', () => {
    renderMenu({ value: 'lmstudio/glm-5.3', hideDefaultOption: true })

    openByClick()

    const selected = options().filter((o) => o.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0]!.textContent).toContain('glm-5.3')
  })

  it('ArrowDown on the trigger opens the menu and focuses the first option', () => {
    renderMenu({ hideDefaultOption: true })

    trigger().focus()
    expect(document.activeElement).toBe(trigger())

    pressKey(trigger(), 'ArrowDown')

    const entries = options()
    expect(entries).toHaveLength(2)
    expect(document.activeElement).toBe(entries[0])
  })

  it('ArrowUp on the trigger opens the menu and focuses the last option', () => {
    renderMenu({ hideDefaultOption: true })

    trigger().focus()
    pressKey(trigger(), 'ArrowUp')

    const entries = options()
    expect(document.activeElement).toBe(entries[entries.length - 1])
  })

  it('ArrowDown/ArrowUp move focus between options and wrap at the ends', () => {
    renderMenu({ hideDefaultOption: true })

    openByClick()
    const entries = options()
    entries[0]!.focus()

    pressKey(entries[0]!, 'ArrowDown')
    expect(document.activeElement).toBe(entries[1])

    // Wrap forward past the last entry.
    pressKey(entries[1]!, 'ArrowDown')
    expect(document.activeElement).toBe(entries[0])

    // Wrap backward past the first entry.
    pressKey(entries[0]!, 'ArrowUp')
    expect(document.activeElement).toBe(entries[1])
  })

  it('activating a focused option selects it by composite id and closes the menu', () => {
    renderMenu({ hideDefaultOption: true })

    openByClick()
    const entries = options()
    entries[1]!.focus()

    act(() => {
      entries[1]!.click()
    })

    expect(onSelect).toHaveBeenCalledWith('lmstudio/glm-5.3')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    // Focus returns to the trigger after the portaled menu unmounts (the
    // WAI-ARIA combobox contract); otherwise it falls to <body> and keyboard
    // users lose their place in the tab order.
    expect(document.activeElement).toBe(trigger())
  })

  it('returns focus to the trigger after choosing the Default option', () => {
    renderMenu()

    openByClick()
    const [defaultOpt] = options()
    defaultOpt!.focus()

    act(() => {
      defaultOpt!.click()
    })

    expect(onSelect).toHaveBeenCalledWith(null)
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })
})
