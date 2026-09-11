// Themes API wrappers.
//
// Wraps the generated Wails bindings (window.go.desktop.App) so components
// never import wailsjs directly. Every RPC response is validated at this
// boundary: malformed data raises a TypeError (never leaks a half-shaped
// record into UI stores), a cancelled picker maps to null, and backend
// errors are logged then re-thrown for the caller to surface.

import { getApp } from './runtime'
import { logger } from '@/lib/logger'
import { isArrayOf } from '@/types/guards'

/** An installed theme known to the backend.
 *  `type` discriminates the theme kind — the value set is backend-owned, so
 *  the guard only pins it to a non-empty contract of "is a string".
 *  `css` carries the theme body on the import result only (list entries are
 *  descriptors); optional at the boundary and validated as a string when
 *  present. */
export interface ThemeInfo {
  id: string
  name: string
  type: string
  css?: string
}

/** Type guard: a well-formed ThemeInfo carries string id/name/type fields. */
export function isThemeInfo(v: unknown): v is ThemeInfo {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.type === 'string' &&
    (o.css === undefined || typeof o.css === 'string')
  )
}

/** Fetch the list of installed themes. Throws TypeError on a malformed response. */
export async function listThemes(): Promise<ThemeInfo[]> {
  try {
    const app = getApp()
    const result = await app.ListThemes()
    if (!Array.isArray(result)) {
      throw new TypeError('listThemes: backend returned non-array data')
    }
    if (!isArrayOf(result, isThemeInfo)) {
      throw new TypeError('listThemes: backend returned malformed ThemeInfo entries')
    }
    return result
  } catch (err) {
    logger.error('Failed to list themes:', err)
    throw err
  }
}

/**
 * Open the native theme picker, import the chosen theme, and return it.
 * Returns null when the user cancels the picker. Throws TypeError when the
 * backend resolves with a record that is not a well-formed ThemeInfo.
 */
export async function pickAndImportTheme(): Promise<ThemeInfo | null> {
  try {
    const app = getApp()
    const result = await app.PickAndImportTheme()
    if (result === null || result === undefined) {
      return null
    }
    if (!isThemeInfo(result)) {
      throw new TypeError('pickAndImportTheme: backend returned invalid ThemeInfo data')
    }
    return result
  } catch (err) {
    logger.error('Failed to pick and import theme:', err)
    throw err
  }
}

/** Delete an installed theme by id. */
export async function deleteTheme(id: string): Promise<void> {
  try {
    const app = getApp()
    await app.DeleteTheme(id)
  } catch (err) {
    logger.error('Failed to delete theme:', err)
    throw err
  }
}
