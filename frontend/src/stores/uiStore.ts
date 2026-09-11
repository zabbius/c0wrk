import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// --- Constants ---

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 500

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

/** Default sidebar width: 1/5 of the screen, clamped to [SIDEBAR_MIN, SIDEBAR_MAX]. */
export function getDefaultSidebarWidth(): number {
  const screenWidth = typeof window !== 'undefined' ? window.innerWidth : 1440
  return clamp(Math.round(screenWidth / 5), SIDEBAR_MIN, SIDEBAR_MAX)
}

// --- State types ---

export type WorkspaceTab = 'explorer' | 'git' | 'semantics' | 'research'

/** Active workspace tab per project id. Persisted so each project remembers its own tab. */
export type WorkspaceTabByProject = Record<string, WorkspaceTab>

/**
 * Valid WorkspaceTab values — used by the persist `merge` (and the `migrate`
 * version step) to validate persisted state entry-by-entry (mirrors
 * GIT_PANEL_TAB_VALUES in gitPanelStore): an unknown/corrupt tab value
 * (hand-edited localStorage or a future shape written by a newer build)
 * matches no TabsTrigger/TabsContent and would render a blank workspace
 * panel, so it is dropped rather than trusted and the project falls back to
 * the default tab.
 */
const WORKSPACE_TAB_VALUES = new Set<WorkspaceTab>(['explorer', 'git', 'semantics', 'research'])

interface UIState {
  sidebarCollapsed: boolean
  /**
   * Active workspace panel tab, keyed by project id. Persisted so switching
   * projects restores each project's last-viewed tab.
   */
  workspaceTabByProject: WorkspaceTabByProject
  /**
   * Sidebar width in pixels (the expanded width; a collapsed sidebar renders at
   * a fixed rail width). Persisted so the user's chosen proportion survives
   * reloads.
   */
  sidebarWidth: number
  /**
   * Vertical split ratio (0..1) between the flat session list and the workspace
   * panel in CHAT (No Project) mode. 0.5 = even split. Persisted so the user's
   * chosen proportion survives reloads.
   */
  chatSessionListRatio: number
  /**
   * Whether the per-run session statistics row (finish state, steps, output
   * tokens, loop-detector counters) renders under the chat. Display-only:
   * metrics are always collected and persisted; this toggle just hides or
   * shows the summary. Off by default. Persisted.
   */
  showSessionStats: boolean
}

interface UIActions {
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebarCollapsed: () => void
  setWorkspaceTab: (projectId: string, tab: WorkspaceTab) => void
  /** Forget the remembered tab for a single project (e.g. on project delete). */
  dropProjectTabs: (projectId: string) => void
  setSidebarWidth: (width: number) => void
  setChatSessionListRatio: (ratio: number) => void
  setShowSessionStats: (show: boolean) => void
}

/** Default workspace tab when a project has no remembered tab yet. */
export const DEFAULT_WORKSPACE_TAB: WorkspaceTab = 'explorer'

/**
 * Pure selector: resolve a project's active workspace tab, defaulting to
 * `'explorer'` when the project has no remembered tab or when no project is
 * active (CHAT / No Project mode) — safe to call with a null/undefined id.
 */
export function selectWorkspaceTab(
  state: Pick<UIState, 'workspaceTabByProject'>,
  projectId: string | null | undefined,
): WorkspaceTab {
  if (projectId === null || projectId === undefined) return DEFAULT_WORKSPACE_TAB
  return state.workspaceTabByProject[projectId] ?? DEFAULT_WORKSPACE_TAB
}

// --- Store ---

/**
 * Rehydrate persisted state into the current state. Zustand's persist
 * middleware calls `merge` on EVERY rehydrate (version match or not), so the
 * per-project workspace-tab validation lives HERE — the `migrate` hook runs
 * only when the stored version differs, and a same-version corrupt value
 * (hand-edited localStorage, or a future build writing a new tab name without
 * bumping `version`) would otherwise rehydrate verbatim and render a blank
 * workspace panel. Mirrors mergeGitPanel's `activeTabByProject` contract.
 * Every scalar field falls back to the current (default) value when its
 * persisted value is missing or has the wrong type.
 */
export function mergeUIStore(
  persisted: unknown,
  current: UIState & UIActions,
): UIState & UIActions {
  const p = (persisted ?? {}) as {
    sidebarCollapsed?: unknown
    sidebarWidth?: unknown
    chatSessionListRatio?: unknown
    showSessionStats?: unknown
    workspaceTabByProject?: unknown
  }
  const workspaceTabByProject: WorkspaceTabByProject = {}
  if (
    p.workspaceTabByProject !== null &&
    typeof p.workspaceTabByProject === 'object'
  ) {
    for (const [projectId, tab] of Object.entries(
      p.workspaceTabByProject as Record<string, unknown>,
    )) {
      if (WORKSPACE_TAB_VALUES.has(tab as WorkspaceTab)) {
        workspaceTabByProject[projectId] = tab as WorkspaceTab
      }
    }
  }
  return {
    ...current,
    sidebarCollapsed:
      typeof p.sidebarCollapsed === 'boolean' ? p.sidebarCollapsed : current.sidebarCollapsed,
    sidebarWidth:
      typeof p.sidebarWidth === 'number' ? p.sidebarWidth : current.sidebarWidth,
    chatSessionListRatio:
      typeof p.chatSessionListRatio === 'number'
        ? p.chatSessionListRatio
        : current.chatSessionListRatio,
    showSessionStats:
      typeof p.showSessionStats === 'boolean' ? p.showSessionStats : current.showSessionStats,
    workspaceTabByProject,
  }
}

export const useUIStore = create<UIState & UIActions>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      workspaceTabByProject: {},
      sidebarWidth: getDefaultSidebarWidth(),
      chatSessionListRatio: 0.5,
      showSessionStats: false,

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

      toggleSidebarCollapsed: () => set((s) => ({
        sidebarCollapsed: !s.sidebarCollapsed,
      })),

      setWorkspaceTab: (projectId, tab) => set((s) => (
        s.workspaceTabByProject[projectId] === tab
          ? s
          : { workspaceTabByProject: { ...s.workspaceTabByProject, [projectId]: tab } }
      )),

      dropProjectTabs: (projectId) => set((s) => {
        if (!(projectId in s.workspaceTabByProject)) return s
        const next = { ...s.workspaceTabByProject }
        delete next[projectId]
        return { workspaceTabByProject: next }
      }),

      setSidebarWidth: (width) => set({ sidebarWidth: clamp(width, SIDEBAR_MIN, SIDEBAR_MAX) }),

      setChatSessionListRatio: (ratio) => set({
        chatSessionListRatio: Math.max(0, Math.min(1, ratio)),
      }),

      setShowSessionStats: (show) => set({ showSessionStats: show }),
    }),
    {
      name: 'c0wrk-sidebar-collapsed',
      version: 5,
      // Bump version and implement migration when adding/removing/renaming persisted fields.
      migrate: (persistedState, _version) => {
        const prev = (persistedState ?? {}) as {
          sidebarCollapsed?: boolean
          chatSessionListRatio?: number
          sidebarWidth?: number
          showSessionStats?: boolean
          workspaceTabByProject?: WorkspaceTabByProject
        }
        // v1→v2 added chatSessionListRatio; v2→v3 added sidebarWidth;
        // v3→v4 added showSessionStats (default off — the stats row is
        // opt-in); v4→v5 replaced the transient workspaceTab scalar with the
        // per-project workspaceTabByProject map. On every migration (and fresh
        // installs) missing fields take their creator default; persist's
        // shallow merge already covers fresh installs, but explicit defaults
        // here make the migration resilient to partial data.
        // workspaceTabByProject is validated entry-by-entry against
        // WORKSPACE_TAB_VALUES (same fail-closed contract as mergeGitPanel's
        // activeTabByProject): unknown tab values are dropped so the store
        // never rehydrates a tab no panel can render.
        const workspaceTabByProject: WorkspaceTabByProject = {}
        if (
          prev.workspaceTabByProject !== null &&
          typeof prev.workspaceTabByProject === 'object'
        ) {
          for (const [projectId, tab] of Object.entries(prev.workspaceTabByProject)) {
            if (WORKSPACE_TAB_VALUES.has(tab as WorkspaceTab)) {
              workspaceTabByProject[projectId] = tab as WorkspaceTab
            }
          }
        }
        return {
          sidebarCollapsed: prev.sidebarCollapsed ?? false,
          chatSessionListRatio: prev.chatSessionListRatio ?? 0.5,
          sidebarWidth: prev.sidebarWidth ?? getDefaultSidebarWidth(),
          showSessionStats: prev.showSessionStats ?? false,
          workspaceTabByProject,
        }
      },
      // merge (not just migrate) validates on every rehydrate — see mergeUIStore.
      merge: mergeUIStore,
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
        chatSessionListRatio: state.chatSessionListRatio,
        showSessionStats: state.showSessionStats,
        workspaceTabByProject: state.workspaceTabByProject,
      }),
    }
  )
)
