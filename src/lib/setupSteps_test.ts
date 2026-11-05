// "Nastavenie obchodu" (update 79): the steps of each kind, where each one is done, the database's answer read safely.
// Run with `npm run test:content`.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { readSetup, SETUP_STEPS, setupHintKey, setupStepHref } from "./setupSteps.ts";

Deno.test("the steps of a shop with stock and of a restaurant (the same order as owner_setup_steps)", () => {
  assertEquals(SETUP_STEPS.goods, ["details", "hours", "stock", "languages", "page", "assistant"]);
  assertEquals(SETUP_STEPS.food, ["details", "hours", "menu", "orders", "couriers", "assistant", "launch"]);
});

Deno.test("each step links to the screen where it is done, with the shop", () => {
  assertEquals(setupStepHref("details", "sk", "bistro"), "/sk/dashboard?shop=bistro&at=details#details");
  assertEquals(setupStepHref("hours", "sk", "bistro"), "/sk/dashboard?shop=bistro&at=details#hours");
  assertEquals(setupStepHref("stock", "hu", "davide"), "/hu/sync?shop=davide&at=source#source");
  assertEquals(setupStepHref("languages", "sk", "davide"), "/sk/sync?shop=davide&at=review#review");
  assertEquals(setupStepHref("page", "sk", "davide"), "/sk/dashboard?shop=davide&at=logo#logo");
  assertEquals(setupStepHref("menu", "sk", "bistro"), "/sk/dashboard/assistant/orders/menu?shop=bistro");
  assertEquals(setupStepHref("orders", "en", "bistro"), "/en/dashboard/assistant/orders/settings?shop=bistro");
  assertEquals(setupStepHref("couriers", "sk", "bistro"), "/sk/dashboard/assistant/orders/couriers?shop=bistro");
  for (const kind of ["goods", "food"] as const) {
    for (const key of SETUP_STEPS[kind]) assert(setupStepHref(key, "sk", "x").startsWith("/sk/"), key);
  }
  assertEquals(setupHintKey("assistant", "food"), "hint_assistant_food");
  assertEquals(setupHintKey("assistant", "goods"), "hint_assistant");
});

Deno.test("the database's answer is read safely; finished = every step done or (optional) skipped", () => {
  const answer = {
    kind: "food",
    steps: [
      { key: "details", done: true, optional: false, skipped: false, missing: [] },
      { key: "couriers", done: false, optional: true, skipped: true, missing: ["couriers"] },
      { key: "nonsense", done: true },
      { key: "launch", done: false, optional: false, skipped: false, missing: ["enabled", 7] },
    ],
  };
  const state = readSetup(answer)!;
  assertEquals(state.steps.map((s) => s.key), ["details", "couriers", "launch"]);
  assertEquals(state.steps[2].missing, ["enabled"]);
  assertEquals([state.done, state.total, state.finished], [1, 3, false]);
  const done = readSetup({ kind: "food", steps: answer.steps.slice(0, 2) })!;
  assert(done.finished, "a skipped optional step counts as finished");
  assertEquals(readSetup(null), null);
  assertEquals(readSetup({ kind: "services", steps: [] }), null);
  assertEquals(readSetup({ kind: "goods" }), null);
});
