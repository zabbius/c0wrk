// Workspace-layout routing helpers.
//
// Where the file explorer lives depends on the active project's workspace:
// a git repository hosts it as the first "files" section INSIDE the Git
// panel (the workspace-level Explorer tab does not exist there), while a
// non-git project keeps the standalone Explorer tab and hides the Git
// entry point entirely. These helpers are the single source of truth for
// that routing so scattered callers cannot drift apart.

import { useProjectStore } from '@/stores/projectStore'
import { useGitPanelStore } from '@/stores/gitPanelStore'
import { useUIStore } from '@/stores/uiStore'

/**
 * Whether the ACTIVE project's workspace is a git repository, per the eager
 * `useProjectGitRepo` check. False while no completed check belongs to the
 * current project — consumers fail closed to the non-git Explorer layout,
 * which is also the pre-check default.
 */
export function activeProjectIsGitRepo(): boolean {
  const { activeProjectId } = useProjectStore.getState()
  const { isGitRepo, gitRepoProjectId } = useGitPanelStore.getState()
  return isGitRepo && gitRepoProjectId === activeProjectId
}

/**
 * Focus the workspace file explorer wherever it lives for the active
 * project: switch to the Git panel's "files" section for a git repository,
 * or to the standalone Explorer tab otherwise.
 */
export function focusFileExplorer(): void {
  if (activeProjectIsGitRepo()) {
    useUIStore.getState().setWorkspaceTab('git')
    useGitPanelStore.getState().setActiveTab('files')
  } else {
    useUIStore.getState().setWorkspaceTab('explorer')
  }
}
