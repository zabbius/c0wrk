// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { EditableCombobox } from './EditableCombobox'

// Radix popper positioning (autoUpdate) observes the trigger/content with
// ResizeObserver, which jsdom does not provide.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
)

const PRESETS = [75, 100, 125, 150] as const

let container: HTMLDivElement
let root: Root
let onChange: ReturnType<typeof vi.fn<(n: number) => void>>

beforeEach(() => {
  onChange = vi.fn()
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

type Props = Partial<Parameters<typeof EditableCombobox>[0]>

function render(props: Props = {}) {
  act(() => {
    root.render(
      <EditableCombobox
        ariaLabel="UI scale"
        value={100}
        presets={PRESETS}
        min={50}
        max={200}
        unit="%"
        onChange={onChange}
        {...props}
      />,
    )
  })
}

function input(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('input[aria-label="UI scale"]')
  expect(el).not.toBeNull()
  return el!
}

function chevron(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('button[aria-label="UI scale presets"]')
  expect(el).not.toBeNull()
  return el!
}

/** Set the input value the way a real browser does (React 19 controlled input):
 *  native prototype setter + `input` event, so the synthetic onChange fires. */
function type(text: string): void {
  const el = input()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('native input setter not found')
  act(() => {
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** React 17+ delegates onBlur via the native `focusout` event. */
async function blur(): Promise<void> {
  await act(async () => {
    input().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function press(key: string, alt = false): void {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, altKey: alt, bubbles: true }))
  })
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

describe('EditableCombobox render', () => {
  it('shows the value and the unit suffix', () => {
    render()
    expect(input().value).toBe('100')
    expect(container.textContent).toContain('%')
  })

  it('renders without a unit', () => {
    render({ unit: undefined })
    expect(input().value).toBe('100')
  })
})

describe('EditableCombobox manual input', () => {
  it('commits a valid value on Enter', () => {
    render()
    type('133')
    press('Enter')
    expect(onChange).toHaveBeenCalledWith(133)
    expect(input().value).toBe('133')
  })

  it('commits a valid value on blur', async () => {
    render()
    type('160')
    await blur()
    expect(onChange).toHaveBeenCalledWith(160)
  })

  it('clamps a below-min value to min on Enter', () => {
    render()
    type('30')
    press('Enter')
    expect(onChange).toHaveBeenCalledWith(50)
    expect(input().value).toBe('50')
  })

  it('clamps an above-max value to max on blur', async () => {
    render()
    type('999')
    await blur()
    expect(onChange).toHaveBeenCalledWith(200)
    expect(input().value).toBe('200')
  })

  it('reverts non-numeric input on Enter without onChange', () => {
    render()
    type('abc')
    press('Enter')
    expect(onChange).not.toHaveBeenCalled()
    expect(input().value).toBe('100')
  })

  it('reverts empty input on blur without onChange', async () => {
    render()
    type('')
    await blur()
    expect(onChange).not.toHaveBeenCalled()
    expect(input().value).toBe('100')
  })

  it('Escape discards the edit without onChange', () => {
    render()
    type('180')
    press('Escape')
    expect(onChange).not.toHaveBeenCalled()
    expect(input().value).toBe('100')
  })
})

describe('EditableCombobox dropdown', () => {
  it('opens via the chevron and renders every preset with the active one checked', async () => {
    render()
    await openDropdown()
    for (const p of PRESETS) {
      expect(menu().textContent).toContain(String(p))
    }
    const selected = menu().querySelector<HTMLElement>('[data-selected="true"]')
    expect(selected).not.toBeNull()
    expect(selected!.textContent).toContain('100')
    // The check mark is the CheckIcon svg inside the selected item.
    expect(selected!.querySelector('svg')).not.toBeNull()
  })

  it('opens via ArrowDown and Alt+ArrowDown from the input', () => {
    render()
    press('ArrowDown')
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    act(() => {
      menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    press('ArrowDown', true)
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
  })

  it('clicking a preset commits it via onChange and closes the menu', async () => {
    render()
    await openDropdown()
    act(() => {
      menuItem('150').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(150)
    expect(input().value).toBe('150')
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
  })

  it('re-picking the current preset is a no-op (no onChange)', async () => {
    render()
    await openDropdown()
    act(() => {
      menuItem('100').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('EditableCombobox inside a modal Radix dialog', () => {
  function renderInDialog() {
    act(() => {
      root.render(
        <Dialog open onOpenChange={() => {}}>
          <DialogContent>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Test harness dialog</DialogDescription>
            <EditableCombobox
              ariaLabel="UI scale"
              value={100}
              presets={PRESETS}
              min={50}
              max={200}
              unit="%"
              onChange={onChange}
            />
          </DialogContent>
        </Dialog>,
      )
    })
    const dialogContent = document.body.querySelector('[data-slot="dialog-content"]')
    expect(dialogContent).not.toBeNull()
  }

  it('commits manual input from inside the dialog', () => {
    renderInDialog()
    const el = document.body.querySelector<HTMLInputElement>('input[aria-label="UI scale"]')
    expect(el).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter!.call(el!, '133')
      el!.dispatchEvent(new Event('input', { bubbles: true }))
      el!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(133)
  })

  it('selects a preset without dismissing the dialog', async () => {
    renderInDialog()
    const btn = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="UI scale presets"]',
    )
    expect(btn).not.toBeNull()
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 10))
    })
    // The modal dialog locks body pointer events; the menu layer must
    // re-enable them for itself (Radix DismissableLayer).
    expect(menu().style.pointerEvents).toBe('auto')
    act(() => {
      menuItem('125').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(125)
    expect(document.body.querySelector('[data-slot="dialog-content"]')).not.toBeNull()
  })
})
