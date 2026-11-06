// `npm run test:food` — "Objednávky jedla" (Prompt 15, updates 73–75) on the website. Every decision lives in SQL and
// is checked by `npm run test:db` (blocks "update 73" … "update 75": quotes only from Sklad, sold out, zones by town,
// postcode and kilometres with their fee and minimum, paused / closed / the last-order cutoff, the SMS code, one order
// per UUID, the steps, paid before delivered, the stock taken once, the courier door). These tests check what the
// website adds: the change to give, the cash quick amounts, Slovak plurals, the step buttons against SQL's own list,
// the cart limits, the town sent to the geocoder, the map links, the courier cookie, that every refusal and state has
// words in sk / hu / en, and that the order panel stays out of the shop page's first load.
import { assert, assertEquals } from "jsr:@std/assert@1";
import en from "../i18n/messages/en.json" with { type: "json" };
import hu from "../i18n/messages/hu.json" with { type: "json" };
import sk from "../i18n/messages/sk.json" with { type: "json" };
import { COURIER_KEY, readCourierKey, signCourierKey } from "./courierKey.ts";
import {
  canContinue,
  cashChoices,
  changeCents,
  cleanCart,
  directionsTo,
  money,
  nextSteps,
  ORDER_PROBLEMS,
  type OrderKind,
  orderKinds,
  pickKind,
  type OrderStatus,
  PAY_NOTE_NONE,
  payNoteLine,
  plural,
  readyClock,
  routeUrl,
  townOf,
  placeWords,
  postcodeFits,
  preselectZone,
  townFits,
  type ZoneOption,
  zoneLabel,
} from "./foodRules.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
/** "35,60 €" uses a no-break space in Slovak and Hungarian; compare with plain spaces. */
const plain = (s: string) => s.replace(/[  ]/g, " ");

Deno.test("change to give: never below zero, nothing while nothing was given", () => {
  assertEquals(changeCents(3560, 5000), 1440);
  assertEquals(changeCents(3560, 3560), 0);
  assertEquals(changeCents(3560, 2000), 0);
  assertEquals(changeCents(3560, null), null);
  assertEquals(changeCents(3560, Number.NaN), null);
  assertEquals(changeCents(1999.6, 2000.4), 0, "whole cents on both sides");
});

Deno.test("cash quick amounts: only the notes that cover the total", () => {
  assertEquals(cashChoices(3560), [4000, 5000, 10_000]);
  assertEquals(cashChoices(1000), [1000, 2000, 3000, 4000, 5000, 10_000], "the exact note counts as covering it");
  assertEquals(cashChoices(950), [1000, 2000, 3000, 4000, 5000, 10_000]);
  assertEquals(cashChoices(12_000), [], "over 100 € only Presne and Iná suma remain");
});

Deno.test("money: the shop's currency in the page's language", () => {
  assertEquals(plain(money(3560, "sk")), "35,60 €");
  assert(plain(money(3560, "hu")).startsWith("35,60 "), "hu: comma decimals (the sign is the runtime's: € or EUR)");
  assertEquals(money(3560, "en"), "€35.60");
  assert(plain(money(250, "sk", "CZK")).startsWith("2,50 "), "another currency keeps its own sign");
});

Deno.test("Slovak plurals: 1 položka, 2–4 položky, 5+ položiek (and 0)", () => {
  const forms = { one: "{n} položka", few: "{n} položky", many: "{n} položiek" };
  assertEquals(plural(1, forms), "1 položka");
  for (const n of [2, 3, 4]) assertEquals(plural(n, forms), `${n} položky`);
  for (const n of [0, 5, 11, 21, 22, 100]) assertEquals(plural(n, forms), `${n} položiek`);
  // English and Hungarian have no "few": everything above one takes the "many" text
  assertEquals(plural(3, { one: "{n} item", few: "{n} items?", many: "{n} items" }, "en"), "3 items");
  assertEquals(plural(1, { one: "{n} tétel", few: "x", many: "{n} tétel" }, "hu"), "1 tétel");
  // the message files carry all three forms for the courier screens and the owner's cards
  for (const m of [sk, hu, en]) {
    const c = m.courier as Record<string, string>;
    for (const k of ["items_one", "items_few", "items_many"]) assert(c[k]?.includes("{n}"), `courier.${k}`);
  }
});

Deno.test("status steps: the buttons offer exactly what food_step_allowed() in SQL allows", async () => {
  const sql = await read("supabase/sql/73_food_orders.sql");
  const fn = sql.slice(sql.indexOf("create or replace function public.food_step_allowed"));
  const body = fn.slice(0, fn.indexOf("$$;"));
  const pairs = (re: RegExp) => [...(body.match(re)?.[1] ?? "").matchAll(/\('(\w+)', '(\w+)'\)/g)].map((m) => `${m[1]}>${m[2]}`);
  const delivery = pairs(/p_kind = 'delivery' then \(p_from, p_to\) in \(([\s\S]*?)\)\s*\n\s*else/);
  const pickup = pairs(/else \(p_from, p_to\) in \(([\s\S]*?)\)\s*\n\s*end/);
  const cancelFrom = [...(body.match(/p_to = 'cancelled' then p_from in \(([^)]*)\)/)?.[1] ?? "").matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert(delivery.length === 4 && pickup.length === 4 && cancelFrom.length === 4, "the SQL list was read");
  const statuses: OrderStatus[] = ["new", "preparing", "on_the_way", "ready", "delivered", "picked_up", "cancelled"];
  const reachable = { delivery: ["new", "preparing", "on_the_way", "delivered", "cancelled"], pickup: ["new", "preparing", "ready", "picked_up", "cancelled"] };
  for (const kind of ["delivery", "pickup"] as OrderKind[]) {
    const allowed = new Set([...(kind === "delivery" ? delivery : pickup), ...cancelFrom.map((f) => `${f}>cancelled`)]);
    for (const from of statuses.filter((s) => reachable[kind].includes(s))) {
      const shown = nextSteps(kind, from).map((to) => `${from}>${to}`).sort();
      const sqlSays = [...allowed].filter((p) => p.startsWith(`${from}>`)).sort();
      assertEquals(shown, sqlSays, `${kind} from ${from}`);
    }
  }
  assertEquals(nextSteps("delivery", "delivered"), [], "a finished order offers nothing");
  assertEquals(nextSteps("pickup", "cancelled"), []);
});

Deno.test("cart: whole pieces 1–50, ≤ 10 extras, ≤ 30 lines — no prices are ever sent", () => {
  assertEquals(cleanCart([{ item_id: ID, qty: 2, extras: [ID2] }]), [{ item_id: ID, qty: 2, extras: [ID2] }]);
  assertEquals(cleanCart([{ item_id: ID, qty: "3.9" }]), [{ item_id: ID, qty: 3, extras: [] }], "pieces are whole");
  const priced = cleanCart([{ item_id: ID, qty: 1, price_cents: 1 }]);
  assertEquals(priced, [{ item_id: ID, qty: 1, extras: [] }], "a price from the browser is dropped");
  for (const bad of [[], null, "x", [{ item_id: ID, qty: 0 }], [{ item_id: ID, qty: 51 }], [{ item_id: "pizza", qty: 1 }],
    [{ item_id: ID, qty: 1, extras: ["x"] }], [{ item_id: ID, qty: 1, extras: Array(11).fill(ID2) }],
    Array(31).fill({ item_id: ID, qty: 1 })]) {
    assertEquals(cleanCart(bad), null, JSON.stringify(bad).slice(0, 60));
  }
});

Deno.test("kilometre zones: only the town of the address goes to the geocoder", () => {
  assertEquals(townOf("Okružná 14, 071 01 Michalovce"), "Michalovce");
  assertEquals(townOf("Okružná 14, 07101 Michalovce"), "Michalovce");
  assertEquals(townOf("Hlavná 5, Pavlovce nad Uhom 072 14"), "Pavlovce nad Uhom");
  assertEquals(townOf("Michalovce"), "Michalovce");
  assertEquals(townOf("Okružná 14"), "Okružná 14", "one part: sent as written (the street alone finds nothing)");
  assertEquals(townOf("Hlavná 1, 071 01"), null, "a postcode alone is not a town");
  assertEquals(townOf(""), null);
  assertEquals(townOf("a, b"), null, "one letter is not a town");
});

Deno.test("map links: the point when there is one, else the written address; the route keeps the order", () => {
  assertEquals(
    directionsTo({ lat: 48.75, lng: 21.92, address: "Okružná 14, Michalovce" }),
    "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=48.75%2C21.92",
  );
  assertEquals(
    directionsTo({ lat: null, lng: null, address: "Okružná 14, Michalovce" }),
    "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=Okru%C5%BEn%C3%A1%2014%2C%20Michalovce",
  );
  assertEquals(directionsTo({ lat: null, lng: null, address: "  " }), null);
  const route = new URL(routeUrl([
    { lat: null, lng: null, address: "A 1, Michalovce" },
    { lat: null, lng: null, address: null },
    { lat: 48.7, lng: 21.9, address: "B 2" },
  ])!);
  assertEquals(route.searchParams.get("destination"), "48.7,21.9");
  assertEquals(route.searchParams.get("waypoints"), "A 1, Michalovce");
  assertEquals(routeUrl([{ lat: null, lng: null, address: null }]), null);
  const many = Array.from({ length: 14 }, (_, i) => ({ lat: null, lng: null, address: `Ulica ${i}` }));
  assertEquals(new URL(routeUrl(many)!).searchParams.get("waypoints")!.split("|").length, 9, "Google takes 9 waypoints");
});

Deno.test("courier cookie: signed with SESSION_COOKIE_SECRET, anything else refused", () => {
  const key = "ckr_" + "ab12".repeat(16);
  const secret = "s".repeat(40);
  assert(COURIER_KEY.test(key));
  const cookie = signCourierKey(key, secret);
  assert(cookie.startsWith(`${key}.`) && cookie.length > key.length + 20);
  assertEquals(readCourierKey(cookie, secret), key);
  assertEquals(readCourierKey(cookie, "t".repeat(40)), null, "another secret");
  assertEquals(readCourierKey(key, secret), null, "unsigned while a secret is set");
  assertEquals(readCourierKey(`${key}.${"x".repeat(43)}`, secret), null, "a made-up signature");
  assertEquals(readCourierKey(cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A"), secret), null, "one character changed");
  assertEquals(signCourierKey(key, null), key, "without the secret the key alone");
  assertEquals(readCourierKey(key, null), key);
  for (const bad of [undefined, "", "ckr_123", "ckr_" + "AB12".repeat(16), "skt_" + "ab12".repeat(16), `x${key}`]) {
    assertEquals(readCourierKey(bad, null), null, String(bad));
  }
});

Deno.test("words for every refusal and state, in sk / hu / en", async () => {
  const bookings = await read("supabase/functions/bookings/index.ts");
  const list = (name: string, text: string) =>
    [...(text.match(new RegExp(`${name} = \\[([\\s\\S]*?)\\] as const`))?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
  const orderReasons = list("ORDER_REASONS", bookings);
  const courierCodeReasons = list("COURIER_REASONS", bookings);
  const door = list("COURIER_REASONS", await read("src/lib/courier.ts"));
  assert(orderReasons.length > 10 && courierCodeReasons.length === 5 && door.length > 10, "the lists were read");
  // a programmer's mistake (a broken request) or a race shows the general "Niečo sa nepodarilo"
  const general = new Set(["qty", "lines", "extras", "kind", "conflict", "bad_request", "courier_expired"]);
  for (const [lang, m] of Object.entries({ sk, hu, en })) {
    const chat = m.chat as Record<string, string>;
    const food = m.food as Record<string, string>;
    const courier = m.courier as Record<string, string>;
    for (const r of [...ORDER_PROBLEMS, ...orderReasons, "wrong_code", "expired", "too_many_attempts", "sms_quota", "sms_failed"]) {
      if (!general.has(r)) assert(chat[`order_err_${r}`], `${lang}: chat.order_err_${r}`);
    }
    assert(chat.order_err_failed, `${lang}: chat.order_err_failed`);
    for (const r of ["off", "paused", "sms_quota", "closed", "cutoff"]) assert(food[`not_accepting_${r}`], `${lang}: food.not_accepting_${r}`);
    for (const s of ["new", "preparing", "on_the_way", "ready", "delivered", "picked_up", "cancelled"]) {
      assert(food[`st_${s}`], `${lang}: food.st_${s}`);
    }
    for (const r of [...door, ...courierCodeReasons, "wrong_code", "expired", "too_many_attempts", "not_found", "sms_failed", "unavailable"]) {
      if (!general.has(r)) assert(courier[`err_${r}`], `${lang}: courier.err_${r}`);
    }
  }
});

Deno.test("first load: the order panel loads only after the first cart card", async () => {
  const chat = await read("src/components/ShopChat.tsx");
  assert(/dynamic\(\s*\(\)\s*=>\s*import\("\.\/OrderPanel"\)/.test(chat), "ShopChat loads OrderPanel through next/dynamic");
  assert(/\{reply\.order && [^\n]*\(\s*\n\s*<OrderPanel/.test(chat), "it is drawn only with the AI's cart card (reply.order)");
  const files: string[] = [];
  const walk = async (dir: URL) => {
    for await (const e of Deno.readDir(dir)) {
      const url = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) await walk(url);
      else if (/\.tsx?$/.test(e.name)) files.push(url.pathname);
    }
  };
  await walk(new URL("src/", root));
  for (const path of files) {
    if (path.endsWith("/OrderPanel.tsx")) continue;
    const text = await Deno.readTextFile(path);
    assert(!/^import[^;]*OrderPanel/m.test(text), `${path} imports OrderPanel directly (it would join the first load)`);
  }
});

// ------------------------------------------------------------------ update 85: the order panel

Deno.test("order panel: Osobný odber and Donáška ALWAYS as two radio buttons, nothing chosen, a way not offered greyed", async () => {
  const both = { pickup: true, delivery: true };
  assertEquals(orderKinds(both), [{ kind: "pickup", available: true }, { kind: "delivery", available: true }]);
  assertEquals(orderKinds({ pickup: true, delivery: false }), [{ kind: "pickup", available: true }, { kind: "delivery", available: false }],
    "without Donáška both are shown, Donáška greyed");
  assertEquals(orderKinds({ pickup: true }), [{ kind: "pickup", available: true }, { kind: "delivery", available: false }],
    "food_state without a zone has no delivery");
  assertEquals(orderKinds({ pickup: false, delivery: true }), [{ kind: "pickup", available: false }, { kind: "delivery", available: true }]);
  assertEquals(orderKinds({ pickup: false, delivery: false }).map((k) => k.available), [true, false], "never no way at all");
  // nothing preselected: "Pokračovať" only after the customer's own pick of an offered way
  const noDelivery = orderKinds({ pickup: true, delivery: false });
  assertEquals(canContinue(null, orderKinds(both), 2), false, "nothing chosen");
  assertEquals(canContinue("pickup", orderKinds(both), 2), true);
  assertEquals(canContinue("delivery", orderKinds(both), 2), true);
  assertEquals(canContinue("delivery", noDelivery, 2), false, "a greyed way never counts");
  assertEquals(canContinue("pickup", orderKinds(both), 0), false, "an empty cart");
  assertEquals(pickKind(noDelivery, "delivery"), null, "a tap on greyed Donáška chooses nothing");
  assertEquals(pickKind(noDelivery, "pickup"), "pickup");
  const panel = await read("src/components/OrderPanel.tsx");
  assert(panel.includes("useState<OrderKind | null>(null)"), "nothing is chosen at first (never the AI's order_kind)");
  assert(!panel.includes("order.kind"), "the answer's order_kind never preselects");
  assert(panel.includes('type="radio"') && panel.includes('className="sr-only"'), "real radio inputs, visually hidden");
  assert(panel.includes("min-h-[52px]") && panel.includes("grid grid-cols-2"), "≥ 52 px high, half the width each");
  assert(panel.includes("bg-foreground font-bold text-white") && panel.includes("border-[1.5px] border-[#E2E2E2] bg-white"),
    "the chosen one black with white bold text, the other white with a 1.5 px #E2E2E2 line");
  assert(panel.includes("rounded-xl"), "radius 12");
  assert(panel.includes("{kinds.map(({ kind: k, available }) =>") && panel.includes("orderKinds(state)"), "both ways, always");
  assert(panel.includes("aria-disabled={available ? undefined : true}"), "a greyed way is aria-disabled");
  assert(panel.includes("labels.order_delivery_off") && panel.includes("setKindHint(k)"), "a tap shows why");
  assert(/onKeyDown=\{\(e\) => \{\s*if \(e\.key === "Enter"\)/.test(panel), "Enter shows it too");
  assert(panel.includes("disabled={busy || !canContinue(kind, kinds, quote.lines.length, { needed: zones.length > 0, chosen: zone })}"),
    "Pokračovať waits for a choice (update 87: and for a zone)");
  assert(panel.includes("labels.order_kind_pick"), "the line under the buttons until a choice");
  assert(/kind === "delivery" && \(\s*<label[^]*name="address"/.test(panel), "the address field only with Donáška");
  assert(panel.includes("value={address}") && panel.includes("setAddress(e.target.value);"),
    "the address is kept while Osobný odber hides the field");
  assert(/function chooseKind[^]*?requote\(\{ kind: k \}\)/.test(panel), "every change asks food_quote again");
  assert(/\{kind \? \(\s*<p[^>]*data-order-time/.test(panel), "the time line once a way is chosen");
  assert(panel.includes("...(k ? { kind: k } : {})"), "before a choice the quote carries no kind");
  // the order route places nothing without the customer's own way
  const route = await read("src/app/api/shops/[slug]/order/route.ts");
  assert(route.includes('body.action === "place" && body.kind !== "pickup" && body.kind !== "delivery"'), "no_kind");
  for (const [name, dict] of Object.entries({ sk, hu, en })) {
    const chat = dict.chat as Record<string, string>;
    for (const key of ["order_kind_pick", "order_delivery_off", "order_pickup_off", "order_err_no_kind"]) assert(chat[key], `${name}: ${key}`);
  }
  assertEquals(sk.chat.order_kind_pick, "Vyberte osobný odber alebo donášku.");
  assertEquals(sk.chat.order_delivery_off, "Tento obchod zatiaľ nedonáša – vyberte osobný odber.");
  assertEquals(hu.chat.order_delivery_off, "Ez az üzlet még nem szállít házhoz – válassza a személyes átvételt.");
  assertEquals(en.chat.order_delivery_off, "This shop doesn't deliver yet – please choose pickup.");
  // the assistant: the buttons ask, never the AI
  const chat = await read("src/lib/shopChat.ts");
  assert(chat.includes("Never ask in words whether the shopper wants pickup or ") && chat.includes("delivery: the buttons ask."));
  assert(!chat.includes("ask about pickup or delivery and extras"));
  assert(chat.includes("say kindly that delivery is not offered yet and pickup is"));
});

Deno.test("order panel: the time line comes from the database's minutes, in the shop's time zone", async () => {
  const at = Date.UTC(2026, 10, 5, 17, 0);
  assertEquals(readyClock(at, 40, "sk", "Europe/Bratislava"), "18:40", "pickup ready at");
  assertEquals(readyClock(at, 70, "sk", "Europe/Bratislava"), "19:10", "delivery by");
  assertEquals(readyClock(at, -5, "sk", "UTC"), "17:00", "never in the past");
  const panel = await read("src/components/OrderPanel.tsx");
  assert(panel.includes("quote.ready_minutes") && panel.includes("state.ready_pickup_min") && panel.includes("state.ready_delivery_min"),
    "food_quote's / food_state's minutes (with the delay), never the assistant's estimate");
  for (const [name, dict] of Object.entries({ sk, hu, en })) {
    assert(dict.chat.order_ready_at.includes("{time}") && dict.chat.order_delivery_by.includes("{time}"), name);
  }
  assertEquals(sk.chat.order_ready_at, "Hotové o {time}");
  assertEquals(sk.chat.order_delivery_by, "Donáška do {time}");
});

Deno.test("order panel: no payment choice for the customer, every order without a pay method", async () => {
  const panel = await read("src/components/OrderPanel.tsx");
  assert(!/pay_method/.test(panel), "the panel sends no pay method");
  assert(!/order_pay_(label|qr|cash|card|hint)/.test(panel) && !/order_done_pay/.test(panel), "no payment block, no method in the box");
  const route = await read("src/app/api/shops/[slug]/order/route.ts");
  assert(route.includes("pay_method: null"), "the website forwards none");
  const fn = await read("supabase/functions/bookings/index.ts");
  assert(fn.includes("p_pay_method: null"), "the bookings function sends none to food_order_create");
  const sql = await read("supabase/sql/85_food_order_panel.sql");
  assert(/values \(p_order_id, v_shop\.id, v_seq, v_day, p_kind, null,/.test(sql), "food_order_create stores no method");
  for (const [name, dict] of Object.entries({ sk, hu, en })) {
    const chat = dict.chat as Record<string, string>;
    for (const key of ["order_pay_label", "order_pay_qr", "order_pay_cash", "order_pay_card", "order_pay_hint_qr",
      "order_pay_hint_cash", "order_pay_hint_card", "order_done_pay", "order_done_pay_line"]) {
      assert(!(key in chat), `${name}: ${key} is gone`);
    }
  }
  const prompt = await read("src/lib/shopChat.ts");
  assert(prompt.includes("Never ask how the shopper will pay and never offer or name a payment method"), "the assistant never asks");
  assert(!prompt.includes("picks pickup or delivery and the payment"), "the card has no payment choice");
});

Deno.test("order panel: the payment note — the default line, the owner's own, \"-\" = none", async () => {
  const fallback = sk.chat.order_pay_note_default;
  assertEquals(fallback, "Uprednostňujeme platbu QR kódom alebo v hotovosti. Ďakujeme!");
  assertEquals(hu.chat.order_pay_note_default, "QR-kódos vagy készpénzes fizetést részesítünk előnyben. Köszönjük!");
  assertEquals(en.chat.order_pay_note_default, "We prefer payment by QR code or cash. Thank you!");
  assertEquals(payNoteLine(null, null, fallback), fallback, "no note = the default line");
  assertEquals(payNoteLine("  ", null, fallback), fallback);
  assertEquals(payNoteLine(PAY_NOTE_NONE, "x", fallback), null, '"-" = no line');
  assertEquals(payNoteLine(" - ", null, fallback), null);
  assertEquals(payNoteLine("Platba len v hotovosti.", null, fallback), "Platba len v hotovosti.", "the owner's own, as written");
  assertEquals(payNoteLine("Platba len v hotovosti.", "Cash only, please.", fallback), "Cash only, please.", "translated");
  const panel = await read("src/components/OrderPanel.tsx");
  assert(panel.includes("payNoteLine(state.pay_note, order.pay_note_translated, labels.order_pay_note_default)"));
  assert(/\{payNote && \(\s*<dd[^>]*data-order-pay-note/.test(panel), "one line under the time, nothing for \"-\"");
  const page = await read("src/app/[lang]/(account)/dashboard/assistant/orders/settings/page.tsx");
  assert(page.includes('name="pay_note"') && page.includes("maxLength={120}"), "Nastavenia: the field, ≤ 120");
  const actions = await read("src/app/[lang]/(account)/dashboard/assistant/orders/actions.ts");
  assert(actions.includes('if (formData.has("pay_note")) p.pay_note'), "saved only when the form has the field");
  const translations = await read("src/lib/contentTranslations.ts");
  assert(/PRESET_KINDS[^\n]*"food_pay_note"/.test(translations), "translated like the assistant's texts");
  const translate = await read("supabase/functions/translate/index.ts");
  assert(translate.includes("food_pay_note:"), "the translate function knows the kind");
  // only the customer sees it: never in the owner's new-order e-mail
  const mail = await read("supabase/functions/crm-messages/index.ts");
  assert(!mail.includes("pay_note"), "not in the owner's e-mail");
});

Deno.test("code SMS: a failed one shows its own words, not \"Príliš veľa pokusov\"", async () => {
  assertEquals(sk.chat.order_err_sms_failed, "SMS sa nepodarilo odoslať – skúste to znova o chvíľu alebo zavolajte do obchodu.");
  for (const [name, dict] of Object.entries({ sk, hu, en })) assert(dict.chat.order_err_sms_failed.length > 10, name);
  const fn = await read("supabase/functions/bookings/index.ts");
  assert(/CODE_REASONS = \[[^\]]*"sms_failed"/.test(fn) && /COURIER_REASONS = \[[^\]]*"sms_failed"/.test(fn), "the refusal is passed on");
});

// ------------------------------------------------------------------ update 87: Donáška without zones, the zone the customer picks

const Z = (id: string, kind: ZoneOption["kind"], value: string | null, extra: Partial<ZoneOption> = {}): ZoneOption => ({
  id, label: value ?? "do 5 km", kind, value: kind === "radius_km" ? null : value, km: kind === "radius_km" ? 5 : null,
  fee_cents: 150, min_cents: 1000, ...extra,
});

Deno.test("zones: the town and postcode rules are the database's (food_town_of / food_town_fits / food_postcode_fits)", () => {
  // the same cases as the DB block "update 87"
  assertEquals(townOf("Okružná 14, 071 01 Michalovce"), "Michalovce");
  assertEquals(townOf("Hlavná 5, Veľké Kapušany 079 01"), "Veľké Kapušany");
  assertEquals(townOf("Váci utca 5, 1051 Budapest"), "Budapest", "a four-digit postcode too");
  assertEquals(townOf("Ulica 5, 04001"), null);
  assertEquals(placeWords("Veľké  Kapušany"), "velke kapusany");
  assert(townFits("Hlavná 5, Veľké Kapušany", "velke kapusany"));
  assert(townFits("Hlavná 5 Veľké Kapušany 079 01", "Veľké Kapušany"), "no comma: the address ends with the town");
  assert(!townFits("Kapušanská 5, Michalovce", "Kapušany"));
  assert(!townFits("Hlavná 5, Pavlovce", "Michalovce"));
  assert(!townFits("Hlavná 5, 07901 Kapušany", "07901"), "a postcode is not a town");
  assert(postcodeFits("Hlavná 5, 071 01 Michalovce", "07101") && postcodeFits("Hlavná 5, 07102 X", "071 01; 071 02"));
  assert(!postcodeFits("Hlavná 5, 04001 Košice", "071 01"));
});

Deno.test("zones: preselect only when the address fits exactly ONE town / postcode zone; kilometres never guessed", () => {
  const zones = [Z("kap", "town", "Veľké Kapušany"), Z("mi", "town", "Michalovce"), Z("psc", "postcode", "071 01"), Z("km", "radius_km", null)];
  assertEquals(preselectZone("Hlavná 5, Veľké Kapušany", zones), "kap");
  assertEquals(preselectZone("Hlavná 5, 04001 Košice", zones), null, "nothing fits: the customer picks");
  assertEquals(preselectZone("Okružná 2, 071 01 Michalovce", zones), null, "two fit (town + postcode): the customer picks");
  assertEquals(preselectZone("Okružná 2, 071 01 Pavlovce", zones), "psc", "by the postcode");
  assertEquals(preselectZone("", zones), null);
  assertEquals(preselectZone("Hlavná 5, Dedina", [Z("km", "radius_km", null)]), null, "a kilometre zone is never guessed");
});

Deno.test("zones: the button's label — the owner's own, the town / postcode, else \"do n km\" in the page language", () => {
  assertEquals(zoneLabel(Z("a", "town", "Michalovce", { label: "Michalovce – centrum", own_label: true }), "do {n} km", "sk"), "Michalovce – centrum");
  assertEquals(zoneLabel(Z("a", "postcode", "071 01"), "do {n} km", "sk"), "071 01");
  assertEquals(zoneLabel(Z("a", "radius_km", null, { km: 7.5, label: "do 7,5 km" }), "do {n} km", "sk"), "do 7,5 km");
  assertEquals(zoneLabel(Z("a", "radius_km", null, { km: 7.5, label: "do 7,5 km" }), "up to {n} km", "en"), "up to 7.5 km");
  assertEquals(zoneLabel(Z("a", "radius_km", null, { km: 7.5, label: "Okolie", own_label: true }), "{n} km-ig", "hu"), "Okolie");
});

Deno.test("zones: Pokračovať needs a zone only for Donáška at a shop with zones", () => {
  const kinds = orderKinds({ pickup: true, delivery: true });
  assertEquals(canContinue("delivery", kinds, 1, { needed: true, chosen: null }), false, "zones, none picked");
  assertEquals(canContinue("delivery", kinds, 1, { needed: true, chosen: "kap" }), true);
  assertEquals(canContinue("delivery", kinds, 1, { needed: false, chosen: null }), true, "no zones: no question");
  assertEquals(canContinue("pickup", kinds, 1, { needed: true, chosen: null }), true, "pickup never asks");
  // update 87: Donáška = its switch alone (food_state.delivery), zones optional
  assertEquals(orderKinds({ pickup: true, delivery: true })[1], { kind: "delivery", available: true });
});

Deno.test("zones: the panel — buttons after the address, one per zone, radios, the fee / minimum, the refusals' words", async () => {
  const panel = await read("src/components/OrderPanel.tsx");
  assert(panel.includes("const zones = state.zone_list ?? [];"), "the zones from food_state");
  assert(panel.includes('const showZones = kind === "delivery" && zones.length > 0 && addressDone && address.trim() !== "";'),
    "only for Donáška, only with zones, after the address");
  assert(panel.includes("onBlur={addressLeft}") && /if \(e\.key === "Enter"\) \{\s*e\.preventDefault\(\);\s*addressLeft\(\);/.test(panel), "on blur or Enter");
  assert(panel.includes("const z = zonePicked ? zone : preselectZone(typed, zones);"), "a pick is never overridden by a guess");
  assert(panel.includes('type="radio"') && panel.includes("name={zoneGroup}") && panel.includes("onChange={() => chooseZone(z.id)}"),
    "real radio inputs (arrows move, the chosen one announced)");
  assert(panel.includes("min-h-[56px] w-full") && panel.includes("rounded-xl") && panel.includes("border-[1.5px] border-[#E2E2E2]"),
    "a long button ≥ 56 px, radius 12, 1.5 px #E2E2E2");
  assert(panel.includes("{on && <CheckIcon />}") && panel.includes("bg-foreground font-bold text-white"), "chosen = black, white bold, a check");
  assert(panel.includes("labels.order_zone_fee") && panel.includes("labels.order_zone_min") && panel.includes("labels.order_zone_question"));
  assert(panel.includes("canContinue(kind, kinds, quote.lines.length, { needed: zones.length > 0, chosen: zone })"), "Pokračovať waits");
  assert(panel.includes('zone: k === "delivery" ? z : null') && panel.includes('zone: kind === "delivery" ? zone : null'),
    "every quote and the order carry the picked zone");
  const route = await read("src/app/api/shops/[slug]/order/route.ts");
  assert(route.includes("const zone = typeof body.zone === \"string\" && UUID.test(body.zone) ? body.zone : null;"), "only a UUID");
  for (const [lang, m] of Object.entries({ sk, hu, en })) {
    const chat = m.chat as Record<string, string>;
    for (const k of ["order_zone_question", "order_zone_fee", "order_zone_no_fee", "order_zone_min", "order_zone_km",
      "order_err_zone_required", "order_err_zone_mismatch", "order_err_zone_unknown"]) assert(chat[k], `${lang}: chat.${k}`);
    assert(chat.order_err_zone_mismatch.includes("{zone}") && chat.order_zone_km.includes("{n}"), lang);
  }
  assertEquals(sk.chat.order_err_zone_mismatch, "Táto adresa nie je v zóne „{zone}“ – vyberte inú alebo opravte adresu.");
  assertEquals(sk.chat.order_err_zone_required, "Vyberte, kam doručujeme.");
  assertEquals(sk.chat.order_zone_question, "Kam doručujeme?");
  // the assistant never picks a zone or names a fee
  const chat = await read("src/lib/shopChat.ts");
  assert(chat.includes("never choose a delivery zone and never name a delivery fee"), "the prompt");
  assert(!/fee: euro\(z\.fee_cents\)/.test(chat), "no zone fee in the tool data");
  // the owner: "Názov pre zákazníka", ▲ ▼, the line under the card
  const settings = await read("src/app/[lang]/(account)/dashboard/assistant/orders/settings/page.tsx");
  assert(settings.includes('name="label" maxLength={40}') && settings.includes("action={moveZone}") && settings.includes("f.s_zones_free"));
  assertEquals(sk.food.s_zones_free, "Bez zón donášame kamkoľvek bez poplatku.");
});
