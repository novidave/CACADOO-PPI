// Admin → Prehľad (2026-11-05): the tiles, "Treba riešiť" and "Služby" from the existing reads; the shops list's order.
// Run with `npm run test:content`.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { isDomainProblem, pluralOf, problemsFirst, services, shopState, tiles, todos, type OverviewShop } from "./adminOverview.ts";

const shop = (o: Partial<OverviewShop>): OverviewShop => ({
  shop_name: "Obchod",
  shop_slug: "obchod",
  has_plan: false,
  domain_id: null,
  hostname: null,
  status: null,
  test_mode: null,
  last_error: null,
  last_error_at: null,
  needs_admin: false,
  waiting_credit: false,
  ...o,
});

const live = shop({ shop_name: "Davide", shop_slug: "davide", has_plan: true, domain_id: "d1", hostname: "davide.sk", status: "live" });
const dns = shop({ shop_name: "Potraviny", shop_slug: "potraviny", has_plan: true, domain_id: "d2", hostname: "potraviny.sk", status: "dns_timeout", last_error: "chýba CNAME www", needs_admin: true });
const credit = shop({ shop_name: "Drogéria", shop_slug: "drogeria", has_plan: true, domain_id: "d3", hostname: "drogeria.sk", status: "paid", waiting_credit: true, test_mode: true });
const free = shop({ shop_name: "Pizzeria", shop_slug: "pizzeria" });

Deno.test("a domain problem = needs_admin, failed, dns_timeout or waiting for credit (as SQL's filter and the badge)", () => {
  assert(isDomainProblem(dns));
  assert(isDomainProblem(credit));
  assert(isDomainProblem(shop({ domain_id: "x", status: "failed" })));
  assert(!isDomainProblem(live));
  assert(!isDomainProblem(free));
  assert(!isDomainProblem(shop({ status: "failed" })), "no domain, no problem");
  assertEquals(problemsFirst([free, live, dns, credit]).map((s) => s.shop_slug), ["potraviny", "drogeria", "pizzeria", "davide"]);
});

Deno.test("the shop row's dot and note", () => {
  assertEquals(shopState(live), { health: "ok", note: null });
  assertEquals(shopState(dns), { health: "bad", note: "needs_admin" });
  assertEquals(shopState(credit), { health: "warn", note: "waiting_credit" });
  assertEquals(shopState(free), { health: "off", note: null });
  assertEquals(shopState(shop({ domain_id: "x", status: "waiting_dns" })).health, "warn");
  assertEquals(shopState(shop({ domain_id: "x", status: "ended" })).health, "off");
});

Deno.test("the four tiles", () => {
  const t = tiles({
    shops: [live, dns, credit, free],
    stats: { live: 1 },
    errors: [{ hits: 9 }, { hits: 6 }, { hits: 2 }],
    sms: [{ used_this_month: 212, shops_at_limit: 1 }, { used_this_month: 148, shops_at_limit: 0 }, { used_this_month: 52, shops_at_limit: 0 }],
  });
  assertEquals(t, {
    shops: { count: 4, pro: 3, free: 1 },
    domains: { count: 3, live: 1, problem: 2 },
    errors: { places: 3, hits: 17 },
    sms: { used: 412, atLimit: 1 },
  });
  // a read that failed: zeros, never an error page
  assertEquals(tiles({ shops: [], stats: null, errors: null, sms: null }).errors, { places: 0, hits: 0 });
});

Deno.test("Treba riešiť: one row per real problem, worst first; nothing = []", () => {
  const rows = todos({
    shops: [live, dns, credit, free],
    credit: 38.2,
    lowCredit: 50,
    telegram: { configured: true, url_ok: false },
    partners: [
      { name: "Partner A", imports: [{ status: "done", error: null, started_at: "2026-11-05T10:00:00Z" }, { status: "error", error: "old", started_at: "2026-11-04T10:00:00Z" }] },
      { name: "Partner B", imports: [{ status: "error", error: "too_big", started_at: "2026-11-05T09:00:00Z" }] },
    ],
    translationAlerted: true,
    translationCost: 20.25,
    connections: [
      { shop: "Davide", provider: "superfaktura", status: "active", last_error: null },
      { shop: "Potraviny", provider: "woocommerce", status: "invalid_key", last_error: "401" },
    ],
  });
  assertEquals(rows.map((r) => [r.health, r.title, r.page]), [
    ["bad", "todo_domain", "shops"],
    ["bad", "todo_telegram_webhook", "integrations"],
    ["bad", "todo_inventory", "inventory"],
    ["warn", "todo_domain", "shops"],
    ["warn", "todo_credit", "shops"],
    ["warn", "todo_partner", "partners"],
    ["warn", "todo_translations", "translations"],
  ]);
  assertEquals(rows.find((r) => r.title === "todo_credit")?.vars, { credit: "38.20", limit: "50.00", waiting: 1 });
  assertEquals(rows.find((r) => r.title === "todo_partner")?.vars.name, "Partner B", "only the partner whose newest import failed");
  const calm = todos({
    shops: [live, free],
    credit: 80,
    lowCredit: 50,
    telegram: { configured: false },
    partners: [],
    translationAlerted: false,
    translationCost: 0,
    connections: [],
  });
  assertEquals(calm, []);
  // a Telegram error after a set webhook is a warning; an unknown credit is no row
  const tg = todos({ shops: [], credit: null, lowCredit: 50, telegram: { configured: true, url_ok: true, last_error: "Bad Gateway" }, partners: null, translationAlerted: false, translationCost: 0, connections: null });
  assertEquals(tg.map((r) => [r.health, r.title]), [["warn", "todo_telegram_error"]]);
});

Deno.test("Služby: a dot and words for each; a function that does not answer = grey neodpovedá", () => {
  const all = services({
    shops: [live, dns, credit, free],
    domainTestMode: false,
    crm: { email: true, sms: "brevo", sms_live: true },
    aiKey: true,
    telegram: { configured: true, url_ok: true },
    facebook: { configured: false },
    search: { todayCalls: 14, limit: 200, on: true },
    partners: [{ name: "A", imports: [] }],
    connections: [{ shop: "Davide", provider: "superfaktura", status: "active", last_error: null }],
  });
  assertEquals(all.map((s) => [s.name, s.health, s.state]), [
    ["svc_websupport", "ok", "svc_live_mode"],
    ["svc_payments", "ok", "svc_subscriptions"],
    ["svc_sms", "ok", "svc_sms_live"],
    ["svc_email", "ok", "svc_sending"],
    ["svc_ai", "ok", "svc_key_set"],
    ["svc_telegram", "ok", "svc_running"],
    ["svc_facebook", "off", "svc_not_set"],
    ["svc_search", "ok", "svc_calls"],
    ["svc_partners", "ok", "svc_count"],
    ["svc_inventory", "ok", "svc_connections"],
  ]);
  const silent = services({
    shops: [],
    domainTestMode: null,
    crm: null,
    aiKey: false,
    telegram: null,
    facebook: null,
    search: null,
    partners: null,
    connections: null,
  });
  assertEquals(silent.filter((s) => s.state === "svc_silent").map((s) => s.name), ["svc_sms", "svc_email", "svc_telegram", "svc_facebook", "svc_search", "svc_partners", "svc_inventory"]);
  assert(silent.filter((s) => s.state === "svc_silent").every((s) => s.health === "off"));
  const test = services({ shops: [], domainTestMode: true, crm: { email: false, sms: "test" }, aiKey: false, telegram: { configured: true, url_ok: false }, facebook: { configured: true }, search: { todayCalls: 200, limit: 200, on: true }, partners: [], connections: [] });
  assertEquals(test.map((s) => [s.name, s.health]), [
    ["svc_websupport", "warn"],
    ["svc_payments", "off"],
    ["svc_sms", "warn"],
    ["svc_email", "bad"],
    ["svc_ai", "off"],
    ["svc_telegram", "bad"],
    ["svc_facebook", "ok"],
    ["svc_search", "warn"],
    ["svc_partners", "off"],
    ["svc_inventory", "off"],
  ]);
});

Deno.test("plural categories for the words", () => {
  assertEquals([1, 2, 4, 5, 0].map((n) => pluralOf("sk", n)), ["one", "few", "few", "other", "other"]);
  assertEquals([1, 2, 5].map((n) => pluralOf("hu", n)), ["one", "other", "other"]);
  assertEquals([1, 2].map((n) => pluralOf("en", n)), ["one", "other"]);
});
