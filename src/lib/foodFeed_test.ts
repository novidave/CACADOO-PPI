// `npm run test:food` — Objednávky jedla's board and green bar (database update 81; no feed since 2026-11-07). SQL
// decides every order (DB block "update 81": finish in one step, payment first, stock once, reopen the same day, the
// parts, the times); these tests check what the board draws with: the order of the cards, the swipe threshold, what a
// finish opens first, the steppers, the phone's first column, the "Čo používate" line, that every text the board needs
// exists in sk / hu / en, and that the feed and its view switch are gone.
import { assert, assertEquals } from "jsr:@std/assert@1";
import en from "../i18n/messages/en.json" with { type: "json" };
import hu from "../i18n/messages/hu.json" with { type: "json" };
import sk from "../i18n/messages/sk.json" with { type: "json" };
import {
  BOARD_KEYS,
  DELAYS,
  DELIVERY_RANGE,
  type FeedOrder,
  type FeedParts,
  fill,
  finishNeeds,
  finishTarget,
  firstColumn,
  partsSummary,
  payMethods,
  PREP_RANGE,
  reopenable,
  sortActive,
  sortDone,
  stepMinutes,
  SWIPE_FLING,
  swipeOutcome,
} from "./foodFeed.ts";

const ALL: FeedParts = { delivery: true, courier_app: true, payments: true, register: true, qr_terminal: true, on: 5 };
const FEED_ONLY: FeedParts = { delivery: false, courier_app: false, payments: false, register: false, qr_terminal: false, on: 0 };
const T0 = Date.parse("2026-11-05T17:45:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const order = (over: Partial<FeedOrder>): FeedOrder => ({
  id: crypto.randomUUID(),
  number: 1,
  kind: "pickup",
  status: "new",
  created_at: at(0),
  ready_by: at(20),
  done_at: null,
  pay_method: "cash",
  paid_at: null,
  courier_id: null,
  courier_name: null,
  address: null,
  ...over,
});

Deno.test("order and grouping: newest on top (or oldest), the same minute by the day's number, done by when", () => {
  const a = order({ number: 1, created_at: at(-30) });
  const b = order({ number: 2, created_at: at(-10) });
  const c = order({ number: 3, created_at: at(-10) });
  assertEquals(sortActive([a, b, c], "newest").map((o) => o.number), [3, 2, 1]);
  assertEquals(sortActive([b, c, a], "oldest").map((o) => o.number), [1, 2, 3]);
  const d1 = order({ number: 4, done_at: at(-5), status: "picked_up" });
  const d2 = order({ number: 5, done_at: at(-1), status: "delivered" });
  assertEquals(sortDone([d1, d2]).map((o) => o.number), [5, 4]);
  // the lists are copies (React state stays as it was)
  const list = [a, b];
  sortActive(list, "newest");
  assertEquals(list[0], a);
});

Deno.test("fill: the names in a text, an unknown one stays as written", () => {
  assertEquals(fill(sk.food.bar_says_pickup, { time: "18:40" }), "odber o 18:40");
  assertEquals(fill("{a} {b}", { a: 1 }), "1 {b}");
});

Deno.test("the phone's board: Nové first; when Nové is empty, the next column with orders", () => {
  assertEquals(firstColumn({ new: 2, preparing: 1, on_the_way: 0, done: 4 }), "new");
  assertEquals(firstColumn({ new: 0, preparing: 0, on_the_way: 3, done: 4 }), "on_the_way");
  assertEquals(firstColumn({ new: 0, preparing: 0, on_the_way: 0, done: 1 }), "done");
  assertEquals(firstColumn({ new: 0, preparing: 0, on_the_way: 0, done: 0 }), "new");
});

Deno.test("the swipe: past 30 % of the card's width it flies out (either way), less springs back", () => {
  assertEquals(SWIPE_FLING, 0.3);
  assertEquals(swipeOutcome(301, 1000), 1);
  assertEquals(swipeOutcome(-301, 1000), -1);
  assertEquals(swipeOutcome(300, 1000), 0, "exactly 30 % springs back");
  assertEquals(swipeOutcome(-120, 390), -1);
  assertEquals(swipeOutcome(100, 390), 0);
  assertEquals(swipeOutcome(500, 0), 0, "no width, no swipe");
  assertEquals(swipeOutcome(Number.NaN, 400), 0);
});

Deno.test("a finish: where it goes, and what it opens first (the courier, the payment) for the parts used", () => {
  const pickup = order({ kind: "pickup" });
  const delivery = order({ kind: "delivery" });
  assertEquals(finishTarget(pickup, ALL), "picked_up");
  assertEquals(finishTarget(delivery, ALL), "on_the_way");
  assertEquals(finishTarget(delivery, { ...ALL, courier_app: false }), "delivered");
  assertEquals(finishTarget({ ...delivery, finish_to: "delivered" }, ALL), "delivered", "SQL's own answer wins");
  assertEquals(finishNeeds(pickup, ALL), "payment");
  assertEquals(finishNeeds({ ...pickup, paid_at: at(-1) }, ALL), null);
  assertEquals(finishNeeds(pickup, FEED_ONLY), null, "without Platby no payment step");
  assertEquals(finishNeeds(delivery, ALL), "courier");
  assertEquals(finishNeeds({ ...delivery, courier_id: crypto.randomUUID() }, ALL), null, "the courier takes the payment");
  assertEquals(finishNeeds(delivery, { ...ALL, courier_app: false }), "payment");
});

Deno.test("the payment choice offers only the methods that are on (QR needs the IBAN), none without Platby", () => {
  const s = { pay_qr: true, pay_cash: true, pay_card: false, iban_set: true };
  assertEquals(payMethods(s, ALL), ["qr", "cash"]);
  assertEquals(payMethods({ ...s, iban_set: false }, ALL), ["cash"]);
  assertEquals(payMethods(s, FEED_ONLY), []);
});

Deno.test("Doručené cards go back unless cancelled", () => {
  assert(reopenable({ status: "picked_up" }) && reopenable({ status: "delivered" }) && reopenable({ status: "on_the_way" }));
  assert(!reopenable({ status: "cancelled" }) && !reopenable({ status: "new" }));
});

Deno.test("the steppers: steps of 5 inside their range; the delay chips", () => {
  assertEquals(stepMinutes(20, 5, PREP_RANGE), 25);
  assertEquals(stepMinutes(5, -5, PREP_RANGE), 5);
  assertEquals(stepMinutes(120, 5, PREP_RANGE), 120);
  assertEquals(stepMinutes(22, 5, PREP_RANGE), 25, "back on the grid of 5");
  assertEquals(stepMinutes(10, -5, DELIVERY_RANGE), 10);
  assertEquals(stepMinutes(175, 5, DELIVERY_RANGE), 180);
  assertEquals([...DELAYS], [0, 10, 20, 30, 45]);
});

Deno.test("Čo používate: only the feed, the feed with delivery, or n of 5", () => {
  assertEquals(partsSummary(FEED_ONLY), { kind: "feed_only" });
  assertEquals(partsSummary({ ...FEED_ONLY, delivery: true, on: 1 }), { kind: "feed_delivery" });
  assertEquals(partsSummary({ ...FEED_ONLY, payments: true, on: 1 }), { kind: "some", n: 1 });
  assertEquals(partsSummary(ALL), { kind: "some", n: 5 });
});

Deno.test("every text of the board in sk, hu and en, with the same placeholders", () => {
  const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const k of [...BOARD_KEYS, "seg_on_the_way", "board_columns"]) {
    const [a, b, c] = [sk.food, hu.food, en.food].map((f) => (f as Record<string, string>)[k]);
    assert(a && b && c, `food.${k} in every language`);
    assertEquals(names(b), names(a), `hu food.${k}`);
    assertEquals(names(c), names(a), `en food.${k}`);
  }
  // the feed's own texts are gone
  for (const k of ["feed_view_label", "feed_view_feed", "feed_view_columns", "feed_active", "feed_finish", "feed_pause"]) {
    assert(!(k in sk.food) && !(k in hu.food) && !(k in en.food), `food.${k} removed`);
  }
});

Deno.test("no feed: the board is the only view, its swipe stays off buttons and links, the bar is a container query", async () => {
  const root = new URL("../../", import.meta.url);
  const read = (p: string) => Deno.readTextFile(new URL(p, root));
  const exists = (p: string) => Deno.stat(new URL(p, root)).then(() => true, () => false);
  assert(!(await exists("src/components/owner/FoodFeed.tsx")), "FoodFeed is gone");
  assert(!(await exists("src/components/owner/FoodViewSwitch.tsx")), "the view switch is gone");
  const page = await read("src/app/[lang]/(account)/dashboard/assistant/orders/page.tsx");
  assert(!page.includes("FOOD_VIEW") && !page.includes("data-food-view"), "no view boot");
  assert(page.includes("<FoodBar") && page.includes("data-food-board"), "the bar and the board");
  const swipe = await read("src/components/owner/BoardSwipe.tsx");
  assert(swipe.includes('closest("a, button, input, select, textarea, label")'), "a swipe never starts on a button or a link");
  assert(swipe.includes("swipeOutcome("), "one threshold rule");
  const bar = await read("src/components/owner/FoodBar.tsx");
  assert(bar.includes("@container") && bar.includes("@[56rem]:flex-row"), "one row from 56 rem of its own width");
  const css = await read("src/app/globals.css");
  assert(!css.includes("data-food-view"), "no view rules");
  assert(/\.ppi-feed-card \{[^}]*touch-action: pan-y/.test(css), "the page still scrolls up and down");
  assert(/prefers-reduced-motion: reduce\) \{\s*\.ppi-feed-card \{\s*transition: none;/.test(css), "no fly-out with reduced motion");
  assert(css.includes('[data-food-board-wrap]:has(input[value="new"]:checked) [data-board-col="new"]'), "the phone's columns by CSS");
  const shop = await read("src/app/[lang]/shops/[slug]/ShopView.tsx");
  assert(!shop.includes("FoodBar") && !shop.includes("FoodFinish"));
});

Deno.test("Nastavenia and the assistant follow the parts: greyed switches keep their choice, no method without Platby", async () => {
  const root = new URL("../../", import.meta.url);
  const read = (p: string) => Deno.readTextFile(new URL(p, root));
  const actions = await read("src/app/[lang]/(account)/dashboard/assistant/orders/actions.ts");
  assert(actions.includes('if (p.delivery_on) p.courier_app = formData.get("courier_app") === "on";'), "the courier app only with Donáška");
  assert(actions.includes('if (p.payments_on) p.qr_terminal = formData.get("qr_terminal") === "on";'), "the QR terminal only with Platby");
  const panel = await read("src/components/OrderPanel.tsx");
  // update 85: no method from the customer at all (with or without Platby)
  assert(!panel.includes("pay_method"), "no method sent");
  assert(panel.includes("state.ready_pickup_min") && panel.includes("state.ready_delivery_min"), "the panel shows food_times");
  const chat = await read("src/lib/shopChat.ts");
  assert(chat.includes("never offer or name a payment method"), "the assistant offers no method");
  assert(chat.includes("BEFORE they order"), "a long delay is said before the order");
  assert(chat.includes("This shop does not deliver now (only pickup): never offer delivery"), "without Donáška only pickup");
  const head = await read("src/app/[lang]/(account)/dashboard/assistant/orders/parts.tsx");
  assert(head.includes('.filter((x) => couriers || x.key !== "couriers")'), "the Kuriéri tab only with the courier app");
});
