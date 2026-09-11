// Native window title — keeps the OS title bar in sync with the active
// project and session, the way an IDE does:
//
//   c0wrk                              no project active (startup)
//   c0wrk - MyProject                  project active, no session selected
//   c0wrk - MyProject - Refactor auth  full context
//   c0wrk - CHAT - Quick question      No Project pseudo-project (CHAT mode)
//
// Driven entirely from the two stores rather than from backend events: the
// project/session lifecycle events already land there (project:switched,
// project:renamed, session:renamed and the optimistic local rename in
// ProjectSelector), so a single derived effect covers startup, switching,
// renaming and deletion without any state of its own.

import { useEffect } from 'react'
import { setWindowTitle } from '@/api/runtime'
import { CHAT_LABEL, selectTitleScope, useProjectStore } from '@/stores/projectStore'
import { selectActiveSessionName, useSessionStore } from '@/stores/sessionStore'

/** Product name — always the first segment. */
export const APP_NAME = 'c0wrk'

/** Re-exported so callers (and tests) can reason about the CHAT segment
 *  without reaching into the project store. */
export { CHAT_LABEL }

/** Separator between title segments, matching common IDE conventions. */
const SEPARATOR = ' - '

/**
 * Build the window title from the scope segment (project name, or CHAT) and
 * the active session name. Segments that are absent — or blank after
 * trimming — are dropped rather than rendered as empty text, so a session
 * without a project can never produce a dangling separator.
 */
export function buildWindowTitle(scope: string | null, sessionName: string | null): string {
  const trimmedScope = scope?.trim()
  if (!trimmedScope) return APP_NAME

  const segments = [APP_NAME, trimmedScope]
  const trimmedSession = sessionName?.trim()
  if (trimmedSession) segments.push(trimmedSession)
  return segments.join(SEPARATOR)
}

/**
 * Push the current project/session context into the native window title.
 *
 * Both selectors return primitives, so the effect re-runs only when the
 * visible text actually changes — activity bumps that rebuild store entries
 * without touching a name do not reach the runtime.
 */
export function useWindowTitle(): void {
  const scope = useProjectStore(selectTitleScope)
  const sessionName = useSessionStore(selectActiveSessionName)

  useEffect(() => {
    setWindowTitle(buildWindowTitle(scope, sessionName))
  }, [scope, sessionName])
}
