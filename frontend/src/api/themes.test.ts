// Unit tests for api/themes.ts — the ThemeInfo type guard and the three RPC
// wrapper functions (happy path, picker cancel, malformed backend data).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock getApp before importing the module under test ---
const mockApp: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

vi.mock('@/api/runtime', () => ({
  getApp: () => mockApp,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}))

import { listThemes, pickAndImportTheme, deleteTheme, isThemeInfo } from '@/api/themes'

// --- Type guard tests ---

describe('isThemeInfo', () => {
  it('accepts a well-formed record', () => {
    expect(isThemeInfo({ id: 'one-dark', name: 'One Dark', type: 'color' })).toBe(true)
  })

  it('accepts a record with empty strings (degenerate but well-typed)', () => {
    expect(isThemeInfo({ id: '', name: '', type: '' })).toBe(true)
  })

  it('rejects null and non-objects', () => {
    expect(isThemeInfo(null)).toBe(false)
    expect(isThemeInfo('one-dark')).toBe(false)
    expect(isThemeInfo(42)).toBe(false)
  })

  it('rejects an array', () => {
    expect(isThemeInfo(['one-dark'])).toBe(false)
  })

  it('rejects missing fields', () => {
    expect(isThemeInfo({ id: 'one-dark', name: 'One Dark' })).toBe(false)
  })

  it('rejects non-string fields', () => {
    expect(isThemeInfo({ id: 7, name: 'One Dark', type: 'color' })).toBe(false)
    expect(isThemeInfo({ id: 'one-dark', name: 7, type: 'color' })).toBe(false)
    expect(isThemeInfo({ id: 'one-dark', name: 'One Dark', type: 7 })).toBe(false)
  })

  it('rejects an object with null field values', () => {
    expect(isThemeInfo({ id: null, name: 'One Dark', type: 'color' })).toBe(false)
  })
})

// --- API wrapper tests ---

describe('listThemes', () => {
  beforeEach(() => {
    Object.keys(mockApp).forEach((k) => delete mockApp[k])
  })

  it('returns themes from the backend', async () => {
    mockApp.ListThemes = vi.fn().mockResolvedValue([
      { id: 'one-dark', name: 'One Dark', type: 'color' },
      { id: 'nord', name: 'Nord', type: 'color' },
    ])
    const result = await listThemes()
    expect(mockApp.ListThemes).toHaveBeenCalled()
    expect(result).toEqual([
      { id: 'one-dark', name: 'One Dark', type: 'color' },
      { id: 'nord', name: 'Nord', type: 'color' },
    ])
  })

  it('returns an empty list when no themes are installed', async () => {
    mockApp.ListThemes = vi.fn().mockResolvedValue([])
    const result = await listThemes()
    expect(result).toEqual([])
  })

  it('throws TypeError when backend returns a non-array', async () => {
    mockApp.ListThemes = vi.fn().mockResolvedValue({ themes: [] })
    await expect(listThemes()).rejects.toThrow(TypeError)
    await expect(listThemes()).rejects.toThrow('non-array')
  })

  it('throws TypeError when an entry has non-string fields', async () => {
    mockApp.ListThemes = vi.fn().mockResolvedValue([
      { id: 'one-dark', name: 'One Dark', type: 'color' },
      { id: 'broken', name: 42, type: 'color' },
    ])
    await expect(listThemes()).rejects.toThrow(TypeError)
    await expect(listThemes()).rejects.toThrow('malformed ThemeInfo')
  })

  it('propagates backend errors', async () => {
    mockApp.ListThemes = vi.fn().mockRejectedValue(new Error('themes dir unreadable'))
    await expect(listThemes()).rejects.toThrow('themes dir unreadable')
  })
})

describe('pickAndImportTheme', () => {
  beforeEach(() => {
    Object.keys(mockApp).forEach((k) => delete mockApp[k])
  })

  it('returns the imported theme on success', async () => {
    const imported = { id: 'gruvbox', name: 'Gruvbox', type: 'color' }
    mockApp.PickAndImportTheme = vi.fn().mockResolvedValue(imported)
    const result = await pickAndImportTheme()
    expect(mockApp.PickAndImportTheme).toHaveBeenCalled()
    expect(result).toEqual(imported)
  })

  it('returns null when the user cancels the picker', async () => {
    mockApp.PickAndImportTheme = vi.fn().mockResolvedValue(null)
    const result = await pickAndImportTheme()
    expect(result).toBeNull()
  })

  it('returns null when the backend resolves undefined (cancel variant)', async () => {
    mockApp.PickAndImportTheme = vi.fn().mockResolvedValue(undefined)
    const result = await pickAndImportTheme()
    expect(result).toBeNull()
  })

  it('throws TypeError when the resolved record has non-string fields', async () => {
    mockApp.PickAndImportTheme = vi.fn().mockResolvedValue({ id: 'x', name: 'X', type: 7 })
    await expect(pickAndImportTheme()).rejects.toThrow(TypeError)
    await expect(pickAndImportTheme()).rejects.toThrow('invalid ThemeInfo')
  })

  it('throws TypeError when the backend resolves a plain string', async () => {
    mockApp.PickAndImportTheme = vi.fn().mockResolvedValue('gruvbox')
    await expect(pickAndImportTheme()).rejects.toThrow(TypeError)
  })

  it('propagates backend errors', async () => {
    mockApp.PickAndImportTheme = vi.fn().mockRejectedValue(new Error('import failed'))
    await expect(pickAndImportTheme()).rejects.toThrow('import failed')
  })
})

describe('deleteTheme', () => {
  beforeEach(() => {
    Object.keys(mockApp).forEach((k) => delete mockApp[k])
  })

  it('calls app.DeleteTheme with the id', async () => {
    mockApp.DeleteTheme = vi.fn().mockResolvedValue(undefined)
    await deleteTheme('one-dark')
    expect(mockApp.DeleteTheme).toHaveBeenCalledWith('one-dark')
  })

  it('propagates backend errors', async () => {
    mockApp.DeleteTheme = vi.fn().mockRejectedValue(new Error('theme in use'))
    await expect(deleteTheme('one-dark')).rejects.toThrow('theme in use')
  })
})
