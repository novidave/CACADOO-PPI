// Unit tests (Deno) of the shop page's Screen 11 rules (2026-10-31): the hold links (contact buttons and "Všetky
// novinky": a finger or a mouse holds 1.2 s — a finger then sees "Pustite" and the link opens on its release, inside
// the release's handler (2026-11-04) —, a short tap only says "Držte stlačené", sliding off cancels, Enter / Space and
// a screen reader's activation open at once) and the stock circle (the database's label → green / red / yellow, with
// the status in words). Run: npm run test:site
import { assertEquals } from "jsr:@std/assert@1";
import { DONE_MS, HINT_MS, HOLD_MS, holdLabel, holdStep, IDLE, releaseBy, type HoldEvent, type HoldState } from "./holdLink.ts";
import { STOCK_BORDERS, STOCK_COLORS, STOCK_WORDS, stockState } from "./stockDot.ts";

const run = (events: HoldEvent[], from: HoldState = IDLE) => {
  let state = from;
  const opened: string[] = [];
  const timers: (number | null | undefined)[] = [];
  for (const e of events) {
    const step = holdStep(state, e);
    state = step.state;
    timers.push(step.timer);
    if (step.open) opened.push(step.open);
  }
  return { state, opened, timers };
};

Deno.test("hold: a finger held 1.2 s says 'Pustite' and opens nothing until it lets go", () => {
  const r = run([{ type: "press", input: "touch" }, { type: "timer" }]);
  assertEquals(r.state, { phase: "ready", input: "touch" });
  assertEquals(r.opened, []);
  // no timer while ready: the link never opens from a timer (a phone hands a link to its app only from a gesture)
  assertEquals(r.timers, [HOLD_MS, null]);
  assertEquals(run([{ type: "timer" }], r.state), { state: r.state, opened: [], timers: [undefined] });
});

Deno.test("hold: the release after the fill opens the link (in this tab, by the release), then idle", () => {
  const r = run([{ type: "press", input: "touch" }, { type: "timer" }, { type: "release" }]);
  assertEquals(r.state.phase, "done");
  assertEquals(r.opened, ["release"]);
  assertEquals(r.timers.at(-1), DONE_MS);
  // once: a second release (the pointerup and the touchend of one lift) opens nothing more
  assertEquals(run([{ type: "release" }], r.state).opened, []);
  assertEquals(run([{ type: "timer" }], r.state).state, IDLE);
  // a pen too
  assertEquals(run([{ type: "press", input: "pen" }, { type: "timer" }, { type: "release" }]).opened, ["release"]);
});

Deno.test("hold: sliding off after 'Pustite' cancels — the release then opens nothing", () => {
  const r = run([{ type: "press", input: "touch" }, { type: "timer" }, { type: "cancel" }, { type: "release" }]);
  assertEquals(r.state, IDLE);
  assertEquals(r.opened, []);
});

Deno.test("hold: who handles a finger's release — touchend on a phone, pointerup for a pen or without touch events", () => {
  assertEquals(releaseBy("touch", true), "touchend");
  assertEquals(releaseBy("touch", false), "pointerup");
  assertEquals(releaseBy("pen", false), "pointerup");
  assertEquals(releaseBy("pen", true), "pointerup");
});

Deno.test("hold: a mouse held 1.2 s opens as the link says at once (a new tab inside its gesture), as before", () => {
  const r = run([{ type: "press", input: "mouse" }, { type: "timer" }]);
  assertEquals(r.state.phase, "done");
  assertEquals(r.opened, ["tab"]);
  // its release afterwards opens nothing more
  assertEquals(run([{ type: "release" }], r.state).opened, []);
});

Deno.test("hold: a short tap only says 'Držte stlačené', then idle; nothing opens", () => {
  const r = run([{ type: "press", input: "touch" }, { type: "release" }]);
  assertEquals(r.state.phase, "hint");
  assertEquals(r.timers.at(-1), HINT_MS);
  assertEquals(r.opened, []);
  // the hint's timer ends it; a late hold timer never opens anything
  assertEquals(run([{ type: "timer" }], r.state), { state: IDLE, opened: [], timers: [null] });
});

Deno.test("hold: sliding off or losing the focus cancels at once", () => {
  const r = run([{ type: "press", input: "touch" }, { type: "cancel" }, { type: "timer" }]);
  assertEquals(r.state, IDLE);
  assertEquals(r.opened, []);
  // letting go before 1.2 s still only hints, also when the release comes twice (pointerup + touchend)
  const early = run([{ type: "press", input: "touch" }, { type: "release" }, { type: "release" }, { type: "timer" }]);
  assertEquals(early.opened, []);
  assertEquals(early.state, IDLE);
});

Deno.test("hold: the keyboard never holds — Enter / Space open at once with the done state", () => {
  const r = run([{ type: "key" }]);
  assertEquals(r.state.phase, "done");
  assertEquals(r.opened, ["tab"]);
  assertEquals(r.timers, [DONE_MS]);
  // pressed again while done: nothing twice
  assertEquals(run([{ type: "key" }], r.state).opened, []);
  // also in the middle of a mouse hold
  assertEquals(run([{ type: "press", input: "mouse" }, { type: "key" }]).opened, ["tab"]);
});

Deno.test("hold: a screen reader's click (no press) lets the browser follow the link", () => {
  const r = run([{ type: "activate" }]);
  assertEquals(r.state.phase, "done");
  assertEquals(r.opened, ["native"]);
});

Deno.test("hold: back from the opened page (back-forward cache) → idle", () => {
  const done = run([{ type: "key" }]).state;
  assertEquals(run([{ type: "reset" }], done).state, IDLE);
});

Deno.test("hold: the label of each phase", () => {
  const labels = { idle: "Facebook", hold: "Držte stlačené", release: "Pustite", done: "Otvorené" };
  assertEquals(
    ["idle", "holding", "hint", "ready", "done"].map((p) => holdLabel(p as never, labels)),
    ["Facebook", "Držte stlačené", "Držte stlačené", "Pustite", "Otvorené"],
  );
});

Deno.test("stock circle: the database's label decides the colour, never recomputed", () => {
  assertEquals(stockState("in_stock_count"), "available");
  assertEquals(stockState("out_of_stock"), "sold_out");
  // stale data or no quantity: no current information
  assertEquals(stockState("stale"), "no_info");
  assertEquals(stockState(null), "no_info");
  assertEquals(stockState(undefined), "no_info");
  assertEquals(STOCK_COLORS, { available: "#22C55E", sold_out: "#EF4444", no_info: "#F5B70A" });
  assertEquals(STOCK_BORDERS, { available: "#15803D", sold_out: "#B91C1C", no_info: "#B7860B" });
  // never colour alone: each state has its words (namespace "stock")
  assertEquals(STOCK_WORDS, { available: "dot_available", sold_out: "dot_sold_out", no_info: "dot_no_info" });
});
