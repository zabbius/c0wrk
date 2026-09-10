// Programmatic sound notifications via the Web Audio API.
//
// Sounds are synthesized at runtime from oscillators — no audio files — so they
// are byte-identical on every platform (the Wails webview — WKWebView on macOS,
// WebView2/Edge on Windows, WebKitGTK on Linux — implements the same Web Audio
// spec). This satisfies the "one identical sound across all three OSes"
// requirement without shipping per-platform assets.

import { useSoundStore } from '@/stores/soundStore'
import { logger } from '@/lib/logger'

/** The three notification categories. */
export type SoundKind = 'success' | 'attention' | 'error'

/** Constructor type for AudioContext (covers the standard API). */
type AudioContextCtor = new (contextOptions?: AudioContextOptions) => AudioContext

/** Lazily-created, reused AudioContext. Module-scoped so every tone shares one
 *  graph + thread pool. Stays null in non-browser (test) environments. */
let audioCtx: AudioContext | null = null
/** True once the persistent user-gesture unlock listeners have been attached,
 *  so we never attach duplicate listeners. */
let unlockRegistered = false
/** True once the context `statechange` recovery listener has been attached. */
let stateChangeRegistered = false
/** Earliest instant (epoch ms) at which a fresh context may be built after the
 *  previous one was found non-revivable. Bounds replacement so a long OS
 *  interruption — during which EVERY resume attempt fails — cannot spin up a
 *  new AudioContext for each cue. */
let ctxBackoffUntil = 0
/** How long to stay silent after dropping a non-revivable context before
 *  building a replacement. */
const CTX_BACKOFF_MS = 1500

/** Resolve the AudioContext constructor (standard + legacy webkit prefix). */
function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

/** True when the audio engine can actually render. Any other state means a cue
 *  scheduled now would be dropped by the engine:
 *  - `suspended`: autoplay policy, or the OS/webview paused rendering;
 *  - `interrupted` (WebKit/Safari, non-standard): an OS-level audio
 *    interruption — display sleep, another app taking audio focus, a call. It
 *    is NOT covered by a `state === 'suspended'` check, which is why the old
 *    check missed the periodic silent stretches on macOS WKWebView;
 *  - `closed`: the context is gone for good. */
function isRunning(ctx: AudioContext): boolean {
  return ctx.state === 'running'
}

/** True when the context is dead for good and can never render again. */
function isTerminal(ctx: AudioContext): boolean {
  return ctx.state === 'closed'
}

/** True when the context is stuck in a state it cannot leave on its own.
 *
 *  WebKit's non-standard `interrupted` state is the trap: while it is set,
 *  `resume()` returns a REJECTED promise (see the "interrupted state" proposal
 *  for the Web Audio API), and a context can wedge there — resume() never
 *  succeeds again, not even from a user gesture. `closed` is equally final.
 *  Such a context must be REPLACED, not resumed. */
function isWedged(ctx: AudioContext): boolean {
  // WebKit's non-standard `interrupted` state is absent from the lib.dom
  // AudioContextState union, so read the state as a plain string.
  const state: string = ctx.state
  return state === 'closed' || state === 'interrupted'
}

/** Best-effort resume of a non-running context. Never rejects; resolves to
 *  whether the context is `running` once the attempt completes, so callers can
 *  sequence playback after it and detect a resume that could not succeed. */
function resumeCtx(ctx: AudioContext): Promise<boolean> {
  if (isRunning(ctx)) return Promise.resolve(true)
  try {
    return Promise.resolve(ctx.resume()).then(
      () => isRunning(ctx),
      (err) => {
        logger.debug('[sound] context resume failed', err)
        return false
      },
    )
  } catch (err) {
    logger.debug('[sound] context resume threw', err)
    return Promise.resolve(false)
  }
}

/** Discard `ctx`, freeing its graph, and detach our statechange tracking from
 *  it. `close()` is best-effort — it rejects on an already-closed context. */
function dropCtx(ctx: AudioContext): void {
  if (audioCtx === ctx) {
    audioCtx = null
    stateChangeRegistered = false
  }
  try {
    void Promise.resolve(ctx.close()).catch(() => { /* already closed */ })
  } catch {
    /* best-effort */
  }
}

/** Drop a context that cannot be revived and start a short backoff before a
 *  replacement is built. Without this replacement the app stayed silent until a
 *  full restart — the reported symptom, because `getCtx` handed back the dead
 *  context forever. */
function markWedged(ctx: AudioContext): void {
  if (audioCtx !== ctx) return
  logger.debug('[sound] replacing non-revivable audio context', ctx.state)
  ctxBackoffUntil = Date.now() + CTX_BACKOFF_MS
  dropCtx(ctx)
}

/** Try to bring `ctx` back to `running`. If it is wedged in a state it can never
 *  leave, drop it so the next cue builds a fresh, revivable context. Resolves to
 *  whether the context is running after the attempt. */
function recoverCtx(ctx: AudioContext): Promise<boolean> {
  return resumeCtx(ctx).then((ok) => {
    if (!ok && isWedged(ctx)) markWedged(ctx)
    return ok
  })
}

/** Attach a one-time `statechange` recovery listener.
 *
 *  The webview/OS can move the context out of `running` at any time (an
 *  autoplay suspend, display sleep, or an OS audio interruption). While it is
 *  not running, cues scheduled on it are discarded, so when we notice it leave
 *  `running` we try to bring it back immediately. A resume triggered by the
 *  state change itself can succeed for OS-initiated suspensions; when it cannot
 *  (WebKit only honors resume() from inside a gesture), the persistent gesture
 *  listeners installed by `initSoundUnlock` recover it on the next
 *  interaction. A context that is wedged (`closed`/`interrupted`) is replaced
 *  outright, because no amount of resuming can revive it. */
function attachStateChangeRecovery(ctx: AudioContext): void {
  if (stateChangeRegistered) return
  stateChangeRegistered = true
  ctx.addEventListener('statechange', () => {
    if (isRunning(ctx)) return
    logger.debug('[sound] audio context left running', ctx.state)
    void recoverCtx(ctx)
  })
}

/** Lazily create (or return the cached) AudioContext. Returns null when the
 *  Web Audio API is unavailable (older webview / tests), when the cached
 *  context is dead, or while a replacement is on backoff after a wedged
 *  context was dropped. */
function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (audioCtx) {
    if (!isTerminal(audioCtx)) return audioCtx
    // A closed context is unrecoverable — drop it and fall through to build a
    // fresh one rather than hand callers a context that can never render.
    dropCtx(audioCtx)
  }
  if (Date.now() < ctxBackoffUntil) return null
  const Ctor = getAudioContextCtor()
  if (!Ctor) return null
  try {
    audioCtx = new Ctor()
    attachStateChangeRecovery(audioCtx)
  } catch (err) {
    logger.warn('[sound] failed to create AudioContext', err)
    return null
  }
  return audioCtx
}

/** A single oscillator note within a multi-note cue. Times are relative to the
 *  start of the cue (seconds). */
interface NoteSpec {
  freq: number
  /** Offset from cue start, in seconds. */
  start: number
  /** Duration of the note, in seconds. */
  duration: number
  type: OscillatorType
  /** Peak gain (0..1). Kept conservative so cues never startle. */
  gain: number
}

function playNote(ctx: AudioContext, spec: NoteSpec): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = spec.type
  osc.frequency.value = spec.freq

  const t0 = ctx.currentTime + spec.start
  const attack = Math.min(0.012, spec.duration * 0.2)
  // Attack → exponential decay envelope for a soft, natural tail.
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(spec.gain, t0 + attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.duration)

  osc.connect(gain).connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + spec.duration + 0.02)
}

// --- Tone presets -----------------------------------------------------------
// Equal-temperament frequencies (Hz):
//   C5 523.251  E5 659.255  G5 783.991  (major triad → positive)
//   A4 440.000                              (single neutral chime)
//   A4 440.000  A3 220.000                   (descending → alarming)

const SUCCESS_NOTES: NoteSpec[] = [
  { freq: 523.251, start: 0.0, duration: 0.14, type: 'sine', gain: 0.18 },
  { freq: 659.255, start: 0.1, duration: 0.14, type: 'sine', gain: 0.18 },
  { freq: 783.991, start: 0.2, duration: 0.26, type: 'sine', gain: 0.2 },
]

const ATTENTION_NOTES: NoteSpec[] = [
  { freq: 440.0, start: 0.0, duration: 0.3, type: 'sine', gain: 0.16 },
]

const ERROR_NOTES: NoteSpec[] = [
  { freq: 440.0, start: 0.0, duration: 0.18, type: 'triangle', gain: 0.22 },
  { freq: 220.0, start: 0.16, duration: 0.34, type: 'triangle', gain: 0.24 },
]

const PRESETS: Record<SoundKind, NoteSpec[]> = {
  success: SUCCESS_NOTES,
  attention: ATTENTION_NOTES,
  error: ERROR_NOTES,
}

/**
 * Play a notification cue. A no-op when the master toggle is off, when the Web
 * Audio API is unavailable, or when the context cannot be brought back to
 * `running` (sound is best-effort: a silent cue must never break the task UI).
 */
export function playSound(kind: SoundKind): void {
  if (!useSoundStore.getState().enabled) return
  const ctx = getCtx()
  if (!ctx) return
  if (isRunning(ctx)) {
    playCue(ctx, kind)
    return
  }
  // Scheduling notes on a non-running context is silently discarded by the
  // engine, so resume FIRST and emit the cue only once the context is actually
  // rendering. The previous implementation fired the resume without awaiting it
  // and scheduled the notes straight away — which is exactly how cues went
  // missing after the context was interrupted or suspended. `recoverCtx` also
  // replaces a context that is wedged in a state it can never leave, so a later
  // cue is not stranded on it forever.
  void recoverCtx(ctx).then((ok) => {
    if (ok) playCue(ctx, kind)
  })
}

/** Schedule every note of a cue on a context that is known to be running. */
function playCue(ctx: AudioContext, kind: SoundKind): void {
  for (const note of PRESETS[kind]) playNote(ctx, note)
}

/** Attempt recovery when the user interacts or returns to the app. WebKit only
 *  honors resume() when it is invoked from a gesture, so a gesture is the main
 *  path that can revive a context the OS suspended mid-session. A context that
 *  is wedged in `interrupted`/`closed` is replaced instead — resume() can never
 *  revive it. */
function recoverOnInteraction(): void {
  const ctx = getCtx()
  if (ctx && !isRunning(ctx)) void recoverCtx(ctx)
}

/**
 * Unlock audio on user gestures, for the lifetime of the app.
 *
 * Desktop webviews (notably macOS WKWebView) start the AudioContext suspended
 * until a user gesture occurs. Notification cues are fired by backend events,
 * not gestures, so the context can stay locked and the first cues play
 * silently. Registering pointer/keyboard/touch listeners that resume the
 * context on user interaction guarantees event-driven cues are audible.
 *
 * Crucially these listeners are PERSISTENT (not `{ once: true }`): the webview
 * suspends/interrupts the context repeatedly (backgrounding, display sleep,
 * audio focus theft), and every such interruption needs a fresh gesture to
 * recover — a one-shot listener that was already consumed leaves no way back,
 * which is the root cause of the periodic silent stretches. Idempotent. */
export function initSoundUnlock(): void {
  if (typeof window === 'undefined' || unlockRegistered) return
  unlockRegistered = true
  window.addEventListener('pointerdown', recoverOnInteraction)
  window.addEventListener('keydown', recoverOnInteraction)
  window.addEventListener('touchstart', recoverOnInteraction)
  // Returning to the app (un-minimising, display wake) is the moment an OS
  // interruption usually ends, so attempt recovery then too — the next cue after
  // the user comes back then plays without waiting for a click.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', (): void => {
      if (document.visibilityState !== 'visible') return
      recoverOnInteraction()
    })
  }
}

/** Test-only: reset module state so unit tests start from a clean slate. */
export function __resetSoundModule(): void {
  audioCtx = null
  unlockRegistered = false
  stateChangeRegistered = false
  ctxBackoffUntil = 0
}
