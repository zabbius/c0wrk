// Fetch-on-focus: the window-focus trigger of the git auto-fetch feature.
//
// Mirrors VS Code's behaviour: whenever the app window regains focus, ask
// the backend to refresh the active project's remote-tracking refs. This
// hook is intentionally dumb — it contains NO gating logic. Every gate
// (the git.auto_fetch master switch, active CODE project vs CHAT/No
// Project, git work tree, configured remote, and the shared 60s
// min-interval across all auto-fetch triggers) lives in the backend
// (FrontendAPI.autoFetchOnce, see backend/frontend_api_git_autofetch.go),
// so the client and server can never disagree about whether a fetch is
// due. In particular, repeated focus events within the min-interval still
// send an RPC — the server silently skips the redundant fetch.
//
// Mount this hook ONCE at the app root (App.tsx), after runtime readiness:
// the focus listener is armed only once the Wails bridge is live (either
// the runtime is already available at mount, or the backend:ready event
// fires). Cleanup always removes the listener, so an unmounted host never
// fires refresh requests.

import { useEffect } from 'react'
import { requestRemoteRefresh } from '@/api/git'
import { isWailsReady, subscribe } from '@/api/runtime'

export function useGitFocusRefresh(): void {
  useEffect(() => {
    let attached = false

    const onFocus = (): void => {
      // Fire-and-forget: requestRemoteRefresh never rejects (errors are
      // swallowed inside the wrapper) and returns immediately — the fetch
      // itself runs in a backend goroutine.
      void requestRemoteRefresh()
    }

    const attach = (): void => {
      if (attached) return
      attached = true
      window.addEventListener('focus', onFocus)
    }

    const detach = (): void => {
      if (!attached) return
      attached = false
      window.removeEventListener('focus', onFocus)
    }

    // Arm only after runtime readiness: before the Wails bindings exist
    // the RPC cannot run, so focus events during the splash phase would be
    // guaranteed no-ops.
    if (isWailsReady()) {
      attach()
      return detach
    }
    const offReady = subscribe('backend:ready', attach)
    return () => {
      offReady()
      detach()
    }
  }, [])
}
