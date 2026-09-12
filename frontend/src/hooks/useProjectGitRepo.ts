// Side-effect-only hook that owns the "is the active project's workspace a
// git repository" detection for the workspace layout.
//
// The WorkspacePanel uses the result to pick the sidebar layout: a git repo
// gets the Git panel (with the file explorer as its first "files" section),
// a non-repo keeps the standalone Explorer tab and hides the Git entry
// point entirely.
//
// Why a dedicated RPC instead of GetGitStatus: the backend's GitStatus
// succeeds with an empty map for a non-repo, so status fulfillment cannot
// distinguish "clean repo" from "no repo". GetIsGitRepo runs
// `git rev-parse --is-inside-work-tree` (backend-cached for 30s, fail
// closed) and is checked eagerly per active project — before the user ever
// opens the Git tab.
//
// - Re-checks on `workspace:tree_changed` (debounced) so a late `git init`
//   or `.git` removal in an external terminal is picked up; the watcher
//   also watches `.git/`.
// - Guards against stale responses: if the active project changed while the
//   RPC was in flight, the result is dropped — the newer effect run owns
//   the store.
// - No Project / no active project: clears the pairing without an RPC
//   (the backend rejects both cases anyway).

import { useEffect, useRef } from 'react'
import { getIsGitRepo } from '@/api/git'
import { subscribe } from '@/api/runtime'
import { useProjectStore, selectIsNoProject } from '@/stores/projectStore'
import { useGitPanelStore } from '@/stores/gitPanelStore'

/** Debounce for tree-change re-checks; the backend caches rev-parse for 30s,
 *  so rapid tree events coalesce into one RPC. */
const TREE_CHANGE_RECHECK_DEBOUNCE_MS = 500

export function useProjectGitRepo(): void {
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const isNoProject = useProjectStore(selectIsNoProject)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!activeProjectId || isNoProject) {
      useGitPanelStore.getState().setGitRepo(false, null)
      return
    }

    let cancelled = false
    const projectId = activeProjectId

    const check = async () => {
      let isRepo = false
      try {
        isRepo = await getIsGitRepo()
      } catch {
        // Fail closed: an unreadable workspace looks like a non-repo. The
        // tree-change re-check self-heals transient failures.
      }
      // Stale guard: the active project changed while the RPC was in
      // flight — drop the result; the newer effect run owns the store.
      if (cancelled || useProjectStore.getState().activeProjectId !== projectId) return
      useGitPanelStore.getState().setGitRepo(isRepo, projectId)
    }

    void check()

    const debouncedCheck = () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current)
      }
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        void check()
      }, TREE_CHANGE_RECHECK_DEBOUNCE_MS)
    }
    const unsub = subscribe('workspace:tree_changed', debouncedCheck)

    return () => {
      cancelled = true
      unsub()
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
    }
  }, [activeProjectId, isNoProject])
}
