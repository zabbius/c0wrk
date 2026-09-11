// Fast taskActive restore on session switch — extracted from ChatArea so the
// flag-repair contract is testable in isolation (see sessionSoundCoverage.test.tsx).
//
// Ownership: this hook is the SOLE switch-time corrector of the destination
// session's `taskActive` flag, writing the backend's authoritative
// `status.active` in BOTH directions (true for a still-running task, false for
// a stale-true left over from a completion nobody observed). useSessionEvents'
// reset effect deliberately does NOT write the flag anymore: its old blind
// `taskActive[dest] = false` corrupted the live map whenever the user toggled
// away before this RPC landed, silently un-watching a genuinely-running
// background session (its completion then had no listener → no sound cue, no
// pending-action card). See specs/domains/frontend/sound-notifications.md.

import { useEffect } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { getSessionRuntimeStatus } from '@/api/chat'
import { logger } from '@/lib/logger'

export function useTaskFlagRestore(activeSessionId: string | null): void {
  useEffect(() => {
    if (!activeSessionId) return
    let cancelled = false
    // Stale-snapshot guard (mirrors reconcileRuntimeStatus): a LIVE flag
    // transition (task_resumed / terminal event / user resume) that lands
    // after this read is fresher than the snapshot — the resolved status must
    // never revert it. Without the guard a resume racing this RPC could flip
    // taskActive back to false mid-run, un-watching the session the moment
    // the user switches away.
    const statusReadAt = Date.now()
    getSessionRuntimeStatus(activeSessionId).then((status) => {
      if (cancelled || !status) return
      if ((useChatStore.getState().taskFlagsEventAt[activeSessionId] ?? 0) > statusReadAt) return
      useChatStore.getState().setTaskActive(activeSessionId, status.active)
    }).catch((err) => {
      logger.error('Failed to get session runtime status:', err)
    })
    return () => { cancelled = true }
  }, [activeSessionId])
}
