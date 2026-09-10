// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { UIScaleSelector } from './UIScaleSelector'
import { useUiScaleStore } from '@/stores/uiScaleStore'

// jsdom in this environment does not expose `window.localStorage`, which
// zustand's persist middleware captures at store-creation time (see
// uiScaleStore.test.ts). Installed before any store module import.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  const win = (g.window as Record<string, unknown> | undefined) ?? g
  const map = new Map<string, string>()
  win.localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size },
  }
})

// Radix popper positioning (autoUpdate) observes trigger/content with
// ResizeObserver, which jsdom does not provide.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
)

const PRESETS = [70, 80, 90, 100, 110, 125, 150, 175, 200]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // Reset the store to defaults between tests; nothing is persisted yet.
  useUiScaleStore.setState({ scale: 100 })
  localStorage.clear()
  document.documentElement.style.zoom = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
})

function scaleInput(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('input[aria-label="UI scale"]')
  expect(el).not.toBeNull()
  return el!
}

function chevron(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('button[aria-label="UI scale presets"]')
  expect(el).not.toBeNull()
  return el!
}

/** Radix's DropdownMenuTrigger toggles on `pointerdown`, not `click`. */
async function openDropdown(): Promise<void> {
  const btn = chevron()
  await act(async () => {
    btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 10))
  })
}

function menu(): HTMLDivElement {
  const el = document.body.querySelector('[role="menu"]')
  expect(el).not.toBeNull()
  return el as HTMLDivElement
}

function menuItem(label: string): HTMLElement {
  const option = Array.from(menu().querySelectorAll<HTMLElement>('[role="menuitem"]')).find((o) =>
    o.textContent?.includes(label),
  )
  if (!option) throw new Error(`Menu item "${label}" not found`)
  return option
}

describe('UIScaleSelector render', () => {
  it('renders the UI Scale label and the current value with a % suffix', () => {
    act(() => {
      root.render(<UIScaleSelector />)
    })
    expect(container.textContent).toContain('UI Scale')
    expect(scaleInput().value).toBe('100')
    expect(container.textContent).toContain('%')
  })

  it('reflects a non-default store value', () => {
    useUiScaleStore.setState({ scale: 150 })
    act(() => {
      root.render(<UIScaleSelector />)
    })
    expect(scaleInput().value).toBe('150')
  })
})

describe('UIScaleSelector presets', () => {
  it('offers the nine presets with the active one marked', async () => {
    act(() => {
      root.render(<UIScaleSelector />)
    })
    await openDropdown()
    for (const p of PRESETS) {
      expect(menu().textContent).toContain(String(p))
    }
    const selected = menu().querySelector<HTMLElement>('[data-selected="true"]')
    expect(selected).not.toBeNull()
    expect(selected!.textContent).toContain('100')
  })

  it('picking a preset updates the store scale and the zoom on <html> immediately', async () => {
    act(() => {
      root.render(<UIScaleSelector />)
    })
    await openDropdown()
    act(() => {
      menuItem('150').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // setScale applies the CSS zoom synchronously — no save step.
    expect(useUiScaleStore.getState().scale).toBe(150)
    expect(document.documentElement.style.zoom).toBe('1.5')
    expect(scaleInput().value).toBe('150')
  })

  it('re-picking the current preset is a no-op (zoom untouched)', async () => {
    useUiScaleStore.setState({ scale: 100 })
    document.documentElement.style.zoom = '1'
    act(() => {
      root.render(<UIScaleSelector />)
    })
    await openDropdown()
    act(() => {
      menuItem('100').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useUiScaleStore.getState().scale).toBe(100)
    expect(document.documentElement.style.zoom).toBe('1')
  })
})

describe('UIScaleSelector manual input', () => {
  /** Set the input value the way a real browser does (React 19 controlled input):
   *  native prototype setter + `input` event, so the synthetic onChange fires. */
  function type(text: string): void {
    const el = scaleInput()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('native input setter not found')
    act(() => {
      setter.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function press(key: string): void {
    act(() => {
      scaleInput().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  }

  it('commits a manual value on Enter, applying the zoom immediately', () => {
    act(() => {
      root.render(<UIScaleSelector />)
    })
    type('125')
    press('Enter')
    expect(useUiScaleStore.getState().scale).toBe(125)
    expect(document.documentElement.style.zoom).toBe('1.25')
    expect(scaleInput().value).toBe('125')
  })

  it('clamps manual input to the supported bounds', () => {
    act(() => {
      root.render(<UIScaleSelector />)
    })
    type('999')
    press('Enter')
    expect(useUiScaleStore.getState().scale).toBe(200)
    expect(document.documentElement.style.zoom).toBe('2')
    expect(scaleInput().value).toBe('200')
  })
})
