import { useCallback } from 'react'
import { EditableCombobox } from '@/components/ui/EditableCombobox'
import { useUiScaleStore, UI_SCALE_MIN, UI_SCALE_MAX } from '@/stores/uiScaleStore'

/** Preset scale choices offered in the dropdown, in percent. */
const UI_SCALE_PRESETS = [70, 80, 90, 100, 110, 125, 150, 175, 200] as const

/**
 * General-tab "UI Scale" block: label + EditableCombobox over the persisted
 * uiScaleStore. Presets cover the common zoom steps; manual input is clamped
 * to [UI_SCALE_MIN, UI_SCALE_MAX] by the combobox and normalized again by the
 * store. onChange maps straight to setScale, which applies the CSS zoom to
 * <html> immediately — there is no apply/save step.
 */
export function UIScaleSelector() {
  const scale = useUiScaleStore((s) => s.scale)
  const setScale = useUiScaleStore((s) => s.setScale)

  const handleScaleChange = useCallback(
    (next: number) => {
      setScale(next)
    },
    [setScale],
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">UI Scale</span>
      </div>
      <EditableCombobox
        value={scale}
        presets={UI_SCALE_PRESETS}
        min={UI_SCALE_MIN}
        max={UI_SCALE_MAX}
        unit="%"
        onChange={handleScaleChange}
        ariaLabel="UI scale"
      />
    </div>
  )
}
