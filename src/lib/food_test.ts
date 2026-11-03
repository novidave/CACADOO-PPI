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
  cashChoices,
  changeCents,
  cleanCart,
  directionsTo,
  money,
  nextSteps,
  ORDER_PROBLEMS,
  type OrderKind,
  type OrderStatus,
  plural,
  routeUrl,
  townOf,
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
  assert(orderReasons.length > 10 && courierCodeReasons.length === 4 && door.length > 10, "the lists were read");
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
