/**
 * The press-and-hold rule of the shop page's hold links (the contact buttons and "Všetky novinky", Screen 11,
 * 2026-10-31): a real link that a finger or a mouse opens only after holding it for 1.2 s, so a phone in a pocket never
 * calls the shop by accident. Pure functions (no React, no DOM): `@/components/HoldLink` runs them, `shopPage_test.ts`
 * checks them.
 *
 * - press (finger, mouse, pen) → holding: the fill grows left to right, the label says "Držte stlačené".
 * - released or slid off before 1.2 s → hint ("Držte stlačené" stays a moment, nothing opens) → idle.
 * - a finger or a pen held 1.2 s → ready: the check and "Pustite"; the link opens ON RELEASE (2026-11-04), inside the
 *   touchend / pointerup handler by a real click on the link — a phone hands a link to its app (Google Maps, the phone,
 *   e-mail; iOS Universal Links, Android App Links and intents) only from a user's gesture, never from a timer. Sliding
 *   off while ready cancels: nothing opens.
 * - a mouse held 1.2 s → done at once: the done label with the check, the link opens (as before); back to idle after
 *   2.3 s.
 * - Enter / Space (keyboard) or a click without a press (a screen reader's activation) → done at once and the link
 *   opens: never a hold on a keyboard.
 */

export const HOLD_MS = 1200;
export const DONE_MS = 2300;
/** How long "Držte stlačené" stays after a short tap. */
export const HINT_MS = 900;

export type HoldPhase = "idle" | "holding" | "hint" | "ready" | "done";
export type HoldInput = "touch" | "mouse" | "pen";

export type HoldEvent =
  | { type: "press"; input: HoldInput }
  /** the finger or the button let go */
  | { type: "release" }
  /** slid off, the press was cancelled, the link lost the focus */
  | { type: "cancel" }
  /** the phase's timer ran out */
  | { type: "timer" }
  /** Enter or Space */
  | { type: "key" }
  /** a click that no press started (assistive technology, a programmatic click) */
  | { type: "activate" }
  /** back from the opened page (the back-forward cache keeps the old state) */
  | { type: "reset" };

/**
 * How the link opens: `tab` = as the link says (a new tab when it has target=_blank — inside the user's gesture),
 * `release` = a finger's release: a real click on the link inside the release handler, in this tab (so the phone may
 * hand it to an app), `native` = let the browser follow the click it is handling.
 */
export type HoldOpen = "tab" | "release" | "native";

export interface HoldState {
  phase: HoldPhase;
  input: HoldInput | null;
}

export interface HoldStep {
  state: HoldState;
  /** open the link now */
  open: HoldOpen | null;
  /** start this timer (ms); null = clear the running one; undefined = keep it */
  timer?: number | null;
}

export const IDLE: HoldState = { phase: "idle", input: null };

const done = (input: HoldInput | null, open: HoldOpen): HoldStep => ({ state: { phase: "done", input }, open, timer: DONE_MS });

export function holdStep(state: HoldState, event: HoldEvent): HoldStep {
  switch (event.type) {
    case "press":
      if (state.phase === "idle" || state.phase === "hint") return { state: { phase: "holding", input: event.input }, open: null, timer: HOLD_MS };
      return { state, open: null };
    case "release":
      if (state.phase === "holding") return { state: { phase: "hint", input: state.input }, open: null, timer: HINT_MS };
      // the finger lets go after the fill: the link opens now, in this handler (the user's gesture)
      if (state.phase === "ready") return done(state.input, "release");
      return { state, open: null };
    case "cancel":
      if (state.phase === "holding" || state.phase === "ready") return { state: IDLE, open: null, timer: null };
      return { state, open: null };
    case "timer":
      // a finger or a pen: "Pustite" — nothing opens before the release (no timer while ready)
      if (state.phase === "holding" && state.input !== "mouse") return { state: { phase: "ready", input: state.input }, open: null, timer: null };
      if (state.phase === "holding") return done(state.input, "tab");
      if (state.phase === "hint" || state.phase === "done") return { state: IDLE, open: null, timer: null };
      return { state, open: null };
    case "key":
      if (state.phase === "done") return { state, open: null };
      return done(null, "tab");
    case "activate":
      if (state.phase === "done") return { state, open: null };
      return done(null, "native");
    case "reset":
      return { state: IDLE, open: null, timer: null };
  }
}

/** The label a hold link shows in a phase ("Pustite" while a finger's hold is ready). */
export function holdLabel(phase: HoldPhase, labels: { idle: string; hold: string; release: string; done: string }): string {
  if (phase === "done") return labels.done;
  if (phase === "ready") return labels.release;
  return phase === "holding" || phase === "hint" ? labels.hold : labels.idle;
}

/**
 * Who handles a finger's release: the touchend handler when the press came with touch events (every phone; the
 * pointerup before it must not open, and the pointerleave that follows a touch's pointerup is not a slide-off), else
 * pointerup (a pen, a touch screen whose browser sends no touch events).
 */
export function releaseBy(input: "touch" | "mouse" | "pen" | null, touchEvents: boolean): "touchend" | "pointerup" {
  return input === "touch" && touchEvents ? "touchend" : "pointerup";
}
