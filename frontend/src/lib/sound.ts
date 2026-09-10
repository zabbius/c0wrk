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

/** Best-effort resume of a non-running context. Never rejects; the returned
 *  promise settles once the attempt completes so callers can sequence playback
 *  after it. */
function resumeCtx(ctx: AudioContext): Promise<void> {
  if (isRunning(ctx)) return Promise.resolve()
  try {
    return Promise.resolve(ctx.resume()).then(
      () => undefined,
      (err) => {
        logger.debug('[sound] context resume failed', err)
      },
    )
  } catch (err) {
    logger.debug('[sound] context resume threw', err)
    return Promise.resolve()
  }
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
 *  interaction. */
function attachStateChangeRecovery(ctx: AudioContext): void {
  if (stateChangeRegistered) return
  stateChangeRegistered = true
  ctx.addEventListener('statechange', () => {
    if (!isRunning(ctx)) {
      logger.debug('[sound] audio context left running', ctx.state)
      void resumeCtx(ctx)
    }
  })
}

/** Lazily create (or return the cached) AudioContext. Returns null when the
 *  Web Audio API is unavailable (older webview / tests). */
function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (audioCtx) return audioCtx
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
  // missing after the context was interrupted or suspended.
  void resumeCtx(ctx).then(() => {
    if (isRunning(ctx)) playCue(ctx, kind)
  })
}

/** Schedule every note of a cue on a context that is known to be running. */
function playCue(ctx: AudioContext, kind: SoundKind): void {
  for (const note of PRESETS[kind]) playNote(ctx, note)
}

/** Resume the shared context from inside a user-gesture callback. WebKit only
 *  honors resume() when it is invoked from a gesture, so this is the only path
 *  that can revive a context the OS suspended mid-session. */
function unlockOnGesture(): void {
  const ctx = getCtx()
  if (ctx && !isRunning(ctx)) void resumeCtx(ctx)
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
  window.addEventListener('pointerdown', unlockOnGesture)
  window.addEventListener('keydown', unlockOnGesture)
  window.addEventListener('touchstart', unlockOnGesture)
}

/** Test-only: reset module state so unit tests start from a clean slate. */
export function __resetSoundModule(): void {
  audioCtx = null
  unlockRegistered = false
  stateChangeRegistered = false
}
