/**
 * The press-and-hold rule of the shop page's hold links (the contact buttons and "Všetky novinky", Screen 11,
 * 2026-10-31): a real link that a finger or a mouse opens only after holding it for 1.2 s, so a phone in a pocket never
 * calls the shop by accident. Pure functions (no React, no DOM): `@/components/HoldLink` runs them, `holdLink_test.ts`
 * checks them.
 *
 * - press (finger, mouse, pen) → holding: the fill grows left to right, the label says "Držte stlačené".
 * - released or slid off before 1.2 s → hint ("Držte stlačené" stays a moment, nothing opens) → idle.
 * - held 1.2 s → done: the done label with the check, the link opens; back to idle after 2.3 s.
 * - Enter / Space (keyboard) or a click without a press (a screen reader's activation) → done at once and the link
 *   opens: never a hold on a keyboard.
 */

export const HOLD_MS = 1200;
export const DONE_MS = 2300;
/** How long "Držte stlačené" stays after a short tap. */
export const HINT_MS = 900;

export type HoldPhase = "idle" | "holding" | "hint" | "done";
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
 * `same` = in this tab (a finger hold has no gesture left that a phone accepts for a new tab), `native` = let the
 * browser follow the click it is handling.
 */
export type HoldOpen = "tab" | "same" | "native";

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
      return { state, open: null };
    case "cancel":
      if (state.phase === "holding") return { state: IDLE, open: null, timer: null };
      return { state, open: null };
    case "timer":
      if (state.phase === "holding") return done(state.input, state.input === "touch" ? "same" : "tab");
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

/** The label a hold link shows in a phase. */
export function holdLabel(phase: HoldPhase, labels: { idle: string; hold: string; done: string }): string {
  return phase === "done" ? labels.done : phase === "holding" || phase === "hint" ? labels.hold : labels.idle;
}
