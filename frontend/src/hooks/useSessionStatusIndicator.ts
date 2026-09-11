// Sidebar session status indicator — derives the green/yellow circle state
// for a session from the chat store, which is the single source of truth for
// live execution and pending-action state.
//
// The previous design mirrored `chatStore.taskActive` into
// `sessionStore.sessions[].active` (dual bookkeeping). That mirroring was
// incomplete — several taskActive transitions (task_resumed, background
// completion, runtime reconciliation) never updated `sessionStore.active` —
// so the green circle disappeared in those paths. Instead of patching every
// mirroring site, the indicator now reads `chatStore` directly.

import { useMemo } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useActiveSessionsStore } from '@/stores/activeSessionsStore'
import type { ChatMessageUI } from '@/types/messages'
import { hasUnresolvedHITL } from '@/lib/hitlTypes'

// Re-exported for existing importers; the implementation lives in
// lib/hitlTypes.ts so lib/activeSessions.ts can share it without a
// hooks → lib dependency inversion.
export { hasUnresolvedHITL }

/** Sidebar indicator state for a session. Mirrors the global badge's
 *  SessionDisplayStatus (lib/activeSessions.ts) so both session-list surfaces
 *  agree on colors; `failed` (red) surfaces a resumable failed task that the DB
 *  recorded but the live chatStore signals alone cannot show. */
export type SessionIndicatorStatus = 'pending' | 'failed' | 'active' | 'paused' | 'idle'

/**
 * Pure derivation of the sidebar indicator from a session's running flag,
 * paused flag, ordered messages, and persisted task status. Exported for unit
 * testing without React rendering.
 *
 * The priority is identical to sessionDisplayStatus (lib/activeSessions.ts):
 * pending > failed > active > paused. Pending takes precedence because a task
 * blocked on a HITL prompt is not "actively processing" — the user's response
 * is the next step, so the awaiting-reaction state is the more informative
 * signal. Active outranks paused (spec: a live running flag, or a DB
 * in_progress snapshot, paints green even when the paused flag — or a DB
 * paused snapshot — is also set), so both session-list surfaces agree.
 *
 * An ARCHIVED session always renders idle, exactly like sessionDisplayStatus's
 * `archived → idle` short-circuit: the badge only surfaces live work, and a
 * stale in-memory live flag (an unresolved HITL card left behind by an archive
 * cancel, or a lagging unfinished_task_status) must not paint a dot on a row
 * the user has archived.
 *
 * `hasPendingOverride` carries the authoritative GetPendingActions sweep
 * result for the session (activeSessionsStore.pendingOverride). It is OR-ed
 * into the message-derived pending check so the sidebar row agrees with the
 * live-sessions radar on the restart path, where chatStore is empty and the
 * blocked prompt is known only from the sweep.
 */
export function deriveSessionIndicatorStatus(
  isRunning: boolean,
  isPaused: boolean,
  messages: ChatMessageUI[],
  dbStatus = '',
  archived = false,
  hasPendingOverride = false,
): SessionIndicatorStatus {
  if (archived) return 'idle'
  if (hasPendingOverride || hasUnresolvedHITL(messages)) return 'pending'
  // The DB snapshot is authoritative for states chatStore cannot see: a task
  // that failed (or was interrupted) while the app was closed leaves the live
  // flags untouched, yet must still surface. Priority mirrors
  // sessionDisplayStatus exactly: pending > failed > active > paused, with
  // unknown non-empty statuses rendering as active (unfinished, never idle).
  if (dbStatus === 'failed') return 'failed'
  if (isRunning || dbStatus === 'in_progress') return 'active'
  if (isPaused || dbStatus === 'paused') return 'paused'
  if (dbStatus !== '') return 'active'
  return 'idle'
}

/**
 * Derive the sidebar status indicator for a session from the chat store,
 * combined with the session's persisted task status (`dbStatus`, i.e.
 * SessionInfo.unfinished_task_status):
 *
 * - `'pending'` (yellow) — an unresolved HITL prompt is awaiting the user.
 * - `'failed'`  (red)    — the DB recorded a failed (resumable) task.
 * - `'active'`  (green)  — a task is currently running (or the DB says in_progress).
 * - `'paused'`  (gray)   — a cooperatively paused task (or the DB says paused).
 * - `'idle'`             — neither.
 */
export function useSessionStatusIndicator(sessionId: string | null, dbStatus = '', archived = false): SessionIndicatorStatus {
  const isRunning = useChatStore(s => (sessionId ? s.taskActive[sessionId] ?? false : false))
  const isPaused = useChatStore(s => (sessionId ? s.paused[sessionId] ?? false : false))
  const messageOrder = useChatStore(s => (sessionId ? s.messageOrder[sessionId] : undefined))
  const messageIndex = useChatStore(s => (sessionId ? s.messages[sessionId] : undefined))
  const hasPendingOverride = useActiveSessionsStore(s => (sessionId ? s.pendingOverride[sessionId] ?? false : false))

  return useMemo(() => {
    const messages: ChatMessageUI[] = []
    if (messageOrder && messageIndex) {
      for (const id of messageOrder) {
        const m = messageIndex[id]
        if (m) messages.push(m)
      }
    }
    return deriveSessionIndicatorStatus(isRunning, isPaused, messages, dbStatus, archived, hasPendingOverride)
  }, [messageOrder, messageIndex, isRunning, isPaused, dbStatus, archived, hasPendingOverride])
}

/**
 * Synchronous (non-hook) busy check for non-render code paths (e.g. session
 * action handlers). Mirrors the row's busy flag: a session is busy when it has
 * a running task, a paused task, or an unfinished task — destructive to
 * archive/delete, so those actions request confirmation. A 'pending' session
 * (awaiting a HITL response) is NOT busy.
 */
export function isSessionBusy(sessionId: string): boolean {
  const chat = useChatStore.getState()
  const isRunning = chat.taskActive[sessionId] ?? false
  const isPaused = chat.paused[sessionId] ?? false

  const messages: ChatMessageUI[] = []
  const messageOrder = chat.messageOrder[sessionId]
  const messageIndex = chat.messages[sessionId]
  if (messageOrder && messageIndex) {
    for (const id of messageOrder) {
      const m = messageIndex[id]
      if (m) messages.push(m)
    }
  }

  const status = deriveSessionIndicatorStatus(isRunning, isPaused, messages)
  if (status === 'active' || status === 'paused') return true

  const session = useSessionStore.getState().sessions?.find((s) => s.id === sessionId)
  return session?.has_unfinished_task ?? false
}
