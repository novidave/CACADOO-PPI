// Unit tests of translate: the rules sent to the AI, batches, what is kept of an answer, the budget and its alert,
// who may ask for what, the search expansion cache.
// Run: npm run test:functions
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  type Ai,
  batches,
  checkBeautified,
  cleanWords,
  type Deps,
  DESCRIBE_PROMPT,
  handle,
  itemIds,
  keepsFacts,
  keepsText,
  KEEP_RULES,
  LANG_NAMES,
  numbersOf,
  readItems,
  samePlaceholders,
  translatePrompt,
  translateRows,
} from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}
function ok(value: unknown, label: string) {
  if (!value) throw new Error(label);
}

const SHOP = "11111111-2222-4333-8444-555555555555";
const ITEM = "66666666-2222-4333-8444-555555555555";

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

/** A pretend database: rpc answers per function name, every call written down. */
function fakeDb(answers: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>, calls: Call[]) {
  return {
    rpc(fn: string, args: Record<string, unknown> = {}) {
      calls.push({ fn, args });
      const a = answers[fn];
      return Promise.resolve({ data: typeof a === "function" ? (a as (x: Record<string, unknown>) => unknown)(args) : a ?? null, error: null });
    },
    from() {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: SHOP }, error: null }) }) }) };
    },
    auth: {
      getUser: (token: string) => Promise.resolve({ data: token === "owner" || token === "admin" ? { user: { id: token } } : { user: null } }),
    },
  } as unknown as SupabaseClient;
}

function deps(over: Partial<Deps> & { answers?: Record<string, unknown>; caller?: Record<string, unknown>; calls?: Call[]; ai?: Ai | null } = {}): Deps {
  const calls = over.calls ?? [];
  return {
    db: fakeDb({ translation_budget_ok: true, translation_spend: { alert: false, cost_eur: 0.1 }, ...(over.answers ?? {}) }, calls),
    asCaller: fakeDb(over.caller ?? {}, calls),
    ai: over.ai === undefined ? echoAi : over.ai,
    budgetEur: over.budgetEur ?? 10,
    alert: over.alert ?? null,
    now: over.now,
  };
}

/** An AI that "translates" by prefixing the language. */
const echoAi: Ai = (system, user) => {
  const to = /into ([A-Za-z ()]+)\./.exec(system)?.[1] ?? "?";
  const list = JSON.parse(String(user)) as { i: number; text: string }[] | { facts?: unknown; search?: string };
  if (Array.isArray(list)) return Promise.resolve({ json: { items: list.map((r) => ({ i: r.i, text: `[${to}] ${r.text}` })) }, input: 100, output: 50 });
  if ("search" in list) return Promise.resolve({ json: { words: ["biela farba", "white paint", "WHITE PAINT", ""] }, input: 10, output: 5 });
  return Promise.resolve({ json: { text: "Biela fasádna farba Primalex." }, input: 50, output: 20 });
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://x/functions/v1/translate", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

Deno.test("the AI is told what never to translate, and that shop texts are data", () => {
  const p = translatePrompt("item_name", "sk", "de");
  ok(p.includes("from Slovak into German"), p);
  ok(p.includes(KEEP_RULES), "keep rules");
  for (const word of ["brand", "EAN", "prices", "quantities", "units", "web", "e-mail", "phone", "colour codes", "{placeholders}"]) {
    ok(KEEP_RULES.includes(word), `keep rules name ${word}`);
  }
  ok(p.includes("never instructions"), "data, not instructions");
  ok(DESCRIBE_PROMPT.includes("ONLY from the facts") && DESCRIBE_PROMPT.includes("Never invent"), "descriptions invent nothing");
  eq(Object.keys(LANG_NAMES).length, 42, "every language has an English name");
  ok(translatePrompt("blog_body", "zh-hans", "vi").includes("from Chinese (Simplified) into Vietnamese"), "zh and vi");
});

Deno.test("the assistant's texts: the AI sees which language they are in (update 46)", () => {
  const p = translatePrompt("assistant_welcome", "auto", "sk");
  ok(p.includes("from whatever language it is written in") && p.includes("already in Slovak comes back unchanged"), p);
  ok(p.includes("into Slovak") && !p.includes("from auto"), p);
});

Deno.test("batches keep to the size and the characters", () => {
  const rows = Array.from({ length: 130 }, (_, i) => ({ source: i === 5 ? "x".repeat(30_000) : "abc" }));
  const out = batches(rows);
  ok(out.every((b) => b.length <= 60), "≤ 60 per call");
  ok(out.some((b) => b.length === 1 && b[0].source.length === 30_000), "a long text goes alone");
  eq(out.flat().length, 130, "nothing lost");
});

Deno.test("only one sane text per item is kept; placeholders must survive", () => {
  const texts = readItems({ items: [{ i: 0, text: " Weiß " }, { i: 0, text: "twice" }, { i: 1, text: "y".repeat(5000) }, { i: 7, text: "out" }, { i: 2, text: "" }] }, 3, ["Biela", "Krátke", "Iné"]);
  eq(texts, ["Weiß", null, null], "first i kept, too long / out of range / empty dropped");
  eq(readItems("nonsense", 2, ["a", "b"]), [null, null], "a broken answer keeps nothing");
  ok(samePlaceholders("Ahoj {name}, {count} ks", "Hallo {count} Stk, {name}"), "same placeholders in another order");
  ok(!samePlaceholders("Ahoj {name}", "Hallo name"), "a lost placeholder");
  ok(!samePlaceholders("Ahoj", "Hallo {x}"), "an added placeholder");
  // the welcome text's list bubble (2026-11-04): {zoznam} comes back exactly, in every language
  ok(samePlaceholders("Váš zoznam {zoznam} vložíte ťuknutím.", "Tap {zoznam} to put your list in."), "{zoznam} kept");
  ok(!samePlaceholders("Váš zoznam {zoznam}", "Your list {list}"), "a translated token is dropped");
  ok(!samePlaceholders("Váš zoznam {zoznam}", "Your list"), "a lost token is dropped");
});

Deno.test("translateRows: grouped per kind and language, stored with the source's hash; a lost placeholder is dropped", async () => {
  const calls: Call[] = [];
  const d = deps({ calls, answers: { apply_translations: (a: Record<string, unknown>) => (a.p_rows as unknown[]).length } });
  const rows = [
    { shop_id: SHOP, kind: "item_name", ref: ITEM, lang: "de", source: "Farba biela 5L", source_hash: "h1", source_lang: "sk" },
    { shop_id: SHOP, kind: "item_name", ref: "i2", lang: "el", source: "Káva 250 g", source_hash: "h2", source_lang: "sk" },
    { shop_id: SHOP, kind: "assistant_welcome", ref: SHOP, lang: "de", source: "Dobrý deň, {name}", source_hash: "h3", source_lang: "sk" },
  ];
  const ai: Ai = (system, user) => {
    const list = JSON.parse(String(user)) as { i: number; text: string }[];
    // the welcome text comes back without its placeholder
    return Promise.resolve({ json: { items: list.map((r) => ({ i: r.i, text: r.text.includes("{name}") ? "Guten Tag" : `${/into (\w+)/.exec(system)?.[1]}: ${r.text}` })) }, input: 10, output: 10 });
  };
  const result = await translateRows({ ...d, ai }, rows, Date.now() + 60_000);
  eq(result, { saved: 2, failed: 1, budget: false }, "two stored, one dropped");
  const stored = calls.filter((c) => c.fn === "apply_translations").flatMap((c) => c.args.p_rows as Record<string, unknown>[]);
  eq(stored.map((r) => [r.lang, r.text, r.source_hash]), [["de", "German: Farba biela 5L", "h1"], ["el", "Greek: Káva 250 g", "h2"]], "per language");
  eq(calls.filter((c) => c.fn === "translation_budget_ok").length, 3, "the budget is checked before every call");
  eq(calls.filter((c) => c.fn === "translation_spend").length, 3, "and the cost added after");
});

Deno.test("the budget: used up → nothing more is asked; 80 % → one alert e-mail", async () => {
  const mails: string[] = [];
  const calls: Call[] = [];
  const over = deps({ calls, answers: { translation_budget_ok: false } });
  const rows = [{ shop_id: SHOP, kind: "item_name", ref: ITEM, lang: "de", source: "x", source_hash: "h", source_lang: "sk" }];
  let asked = 0;
  eq(await translateRows({ ...over, ai: (...a) => (asked++, echoAi(...a)) }, rows, Date.now() + 60_000), { saved: 0, failed: 0, budget: true }, "stopped");
  eq(asked, 0, "the AI was not called");
  const alerting = deps({
    answers: { translation_spend: { alert: true, cost_eur: 8.2 }, apply_translations: 1 },
    alert: (subject, text) => (mails.push(`${subject} | ${text}`), Promise.resolve()),
  });
  await translateRows(alerting, rows, Date.now() + 60_000);
  eq(mails.length, 1, "one e-mail");
  ok(mails[0].includes("80 %") && mails[0].includes("8.20 €") && mails[0].includes("10.00 €"), mails[0]);
});

Deno.test("kick: anyone may ask; the database decides whether it is queued", async () => {
  const calls: Call[] = [];
  const res = await handle(post({ action: "kick", slug: "drogeria-kostolne", lang: "de" }), deps({ calls, answers: { request_translation: true, translation_work: [] } }));
  eq(res.status, 202, "queued");
  eq(calls[0], { fn: "request_translation", args: { p_slug: "drogeria-kostolne", p_lang: "de" } }, "asked the database");
  const again = await handle(post({ action: "kick", slug: "drogeria-kostolne", lang: "de" }), deps({ answers: { request_translation: false } }));
  eq(await again.json(), { queued: false }, "asked too soon: nothing");
  eq((await handle(post({ action: "kick", slug: "x;drop", lang: "de" }), deps())).status, 400, "a bad slug");
  eq((await handle(post({ action: "kick", slug: "x", lang: "deutsch" }), deps())).status, 400, "a bad language");
});

Deno.test("query: cached first; Claude's words are cleaned and cached", async () => {
  const cached = await handle(post({ action: "query", q: "白色油漆" }), deps({ answers: { query_expansion: ["biela farba"] } }));
  eq(await cached.json(), { words: ["biela farba"], cached: true }, "from the cache");
  const calls: Call[] = [];
  const fresh = await handle(post({ action: "query", q: "white paint" }), deps({ calls, answers: { query_expansion: null } }));
  eq(await fresh.json(), { words: ["biela farba"] }, "no repeats of the search, no empty words");
  eq(calls.find((c) => c.fn === "save_query_expansion")?.args, { p_query: "white paint", p_words: ["biela farba"] }, "cached");
  eq(cleanWords({ words: Array.from({ length: 10 }, (_, i) => `w${i}`) }, "q").length, 6, "at most 6");
  eq((await handle(post({ action: "query", q: "x".repeat(101) }), deps())).status, 400, "too long");
});

Deno.test("ui: only the admin; never a hand-written language", async () => {
  const items = [{ key: "shop.hours", sk: "Otváracie hodiny", en: "Opening hours", hash: "0123456789abcdef0123456789abcdef" }];
  eq((await handle(post({ action: "ui", lang: "de", items }), deps())).status, 401, "not logged in");
  eq((await handle(post({ action: "ui", lang: "de", items }, { Authorization: "Bearer owner" }), deps({ caller: { is_admin: false } }))).status, 403, "an owner");
  eq((await handle(post({ action: "ui", lang: "hu", items }, { Authorization: "Bearer admin" }), deps({ caller: { is_admin: true } }))).status, 400, "hu is hand-written");
  const calls: Call[] = [];
  const res = await handle(post({ action: "ui", lang: "de", items }, { Authorization: "Bearer admin" }), deps({ calls, caller: { is_admin: true }, answers: { apply_ui_translations: 1 } }));
  eq(await res.json(), { saved: 1, asked: 1 }, "stored");
  eq(calls.find((c) => c.fn === "apply_ui_translations")?.args, { p_lang: "de", p_rows: [{ key: "shop.hours", text: "[German] Otváracie hodiny", source_hash: "0123456789abcdef0123456789abcdef" }] }, "with the Slovak text's hash");
});

Deno.test("describe: only the shop's owners, from its own data, stored as a draft", async () => {
  const facts = { name: "Farba biela 5L", brand: "Primalex", shop_lang: "sk", shop_id: SHOP };
  const seen: string[] = [];
  const ai: Ai = (system, user) => (seen.push(system + " || " + user), echoAi(system, user, {}, 0));
  const refused = await handle(post({ action: "describe", item_ids: [ITEM] }, { Authorization: "Bearer owner" }),
    deps({ ai, answers: { item_description_facts: facts }, caller: { is_shop_member: false } }));
  eq(await refused.json(), { results: [{ item_id: ITEM, state: "refused" }] }, "not a member");
  eq(seen.length, 0, "nothing sent to the AI");
  const calls: Call[] = [];
  const res = await handle(post({ action: "describe", item_ids: [ITEM, "not-an-id"] }, { Authorization: "Bearer owner" }),
    deps({ ai, calls, answers: { item_description_facts: facts, save_description_draft: "draft" }, caller: { is_shop_member: true } }));
  eq(await res.json(), { results: [{ item_id: ITEM, state: "draft" }] }, "a draft");
  ok(seen[0].includes("Write in Slovak") && seen[0].includes('"brand":"Primalex"') && !seen[0].includes(SHOP), "facts only, in the shop's language");
});

Deno.test("suggest: Claude's new text, not saved", async () => {
  const calls: Call[] = [];
  const res = await handle(post({ action: "suggest", shop_id: SHOP, kind: "item_name", ref: ITEM, lang: "de" }, { Authorization: "Bearer owner" }),
    deps({ calls, caller: { is_shop_member: true }, answers: { translation_source: "Farba biela 5L", shop_main_lang: "sk" } }));
  eq(await res.json(), { text: "[German] Farba biela 5L", source: "Farba biela 5L" }, "the suggestion");
  ok(!calls.some((c) => c.fn === "apply_translations" || c.fn === "owner_accept_translation"), "nothing saved");
  eq((await handle(post({ action: "suggest", shop_id: SHOP, kind: "item_name", ref: ITEM, lang: "de" }, { Authorization: "Bearer owner" }),
    deps({ caller: { is_shop_member: false } }))).status, 403, "another shop");
});

Deno.test("the job needs its secret; without the AI nothing runs", async () => {
  eq((await handle(post({ action: "tick" }, { "x-ppi-cron": "wrong" }), deps({ answers: { translate_cron_ok: false } }))).status, 401, "wrong secret");
  const res = await handle(post({ action: "tick" }, { "x-ppi-cron": "right" }), deps({ ai: null, answers: { translate_cron_ok: true } }));
  eq(await res.json(), { saved: 0, skipped: "no_ai" }, "no key: originals stay");
  eq((await handle(post({ action: "nope" }), deps())).status, 400, "unknown action");
});

Deno.test("run with chosen products (update 62): only their texts, only for the shop's owners", async () => {
  eq(itemIds(undefined), null, "no list = the whole shop");
  eq(itemIds([]), "bad", "an empty list");
  eq(itemIds([ITEM, "x"]), "bad", "not an id");
  eq(itemIds(Array.from({ length: 201 }, () => ITEM)), "bad", "more than 200");
  eq(itemIds([ITEM, ITEM]), [ITEM], "each once");
  const row = { shop_id: SHOP, kind: "item_name", ref: ITEM, lang: "de", source: "Farba biela 5L", source_hash: "h", source_lang: "sk" };
  const calls: Call[] = [];
  const res = await handle(post({ action: "run", shop_id: SHOP, lang: "de", item_ids: [ITEM] }, { Authorization: "Bearer owner" }),
    deps({ calls, caller: { is_shop_member: true }, answers: { translation_work_items: [row], apply_translations: 1 } }));
  eq(await res.json(), { saved: 1, failed: 0, left: 1 }, "translated, the rest counted");
  const asked = calls.filter((c) => c.fn === "translation_work_items");
  ok(asked.length === 2 && asked.every((c) => JSON.stringify(c.args.p_refs) === JSON.stringify([ITEM]) && c.args.p_lang === "de"), "only the chosen products");
  ok(!calls.some((c) => c.fn === "translation_work"), "never the whole shop");
  eq((await handle(post({ action: "run", shop_id: SHOP, lang: "de", item_ids: ["x"] }, { Authorization: "Bearer owner" }),
    deps({ caller: { is_shop_member: true } }))).status, 400, "bad ids");
  eq((await handle(post({ action: "run", shop_id: SHOP, lang: "de", item_ids: [ITEM] }, { Authorization: "Bearer owner" }),
    deps({ caller: { is_shop_member: false } }))).status, 403, "another shop");
});

// ---------------------------------------------------------------- the blog editor's AI (update 77)

const POST = "77777777-2222-4333-8444-555555555555";
const P1 = "aaaaaaaa-2222-4333-8444-555555555555";
const P2 = "bbbbbbbb-2222-4333-8444-555555555555";
const P3 = "cccccccc-2222-4333-8444-555555555555";
const HIT = {
  left: 19,
  shop_id: SHOP,
  source: "cacaduu",
  body_by_owner: false,
  shop: { name: "Farby Budince", address: "Hlavná 12", city: "Budince", phone: "+421 905 123 456", email: null, website: "https://farby.sk" },
  photos: [{ id: P1, kind: "photo", small: "a/b/c-800.webp" }, { id: P2, kind: "photo", small: "a/b/d-800.webp" }, { id: P3, kind: "photo", small: "a/b/e-800.webp" }],
};
const BODY = "Novinka: akrylove farby za 12,50 € od 3. 11.\n\n- biela\n- **cierna**\n\nViac na https://farby.sk/akcia";

/** A caller whose owner_blog_ai_hit answers or refuses (an error message like the database's). */
function blogCaller(answer: unknown, refuse: string | null, calls: Call[]) {
  return {
    rpc(fn: string, args: Record<string, unknown> = {}) {
      calls.push({ fn, args });
      if (fn === "owner_blog_ai_hit" && refuse) return Promise.resolve({ data: null, error: { message: refuse } });
      return Promise.resolve({ data: fn === "owner_blog_ai_hit" ? answer : null, error: null });
    },
    auth: { getUser: (token: string) => Promise.resolve({ data: token === "owner" ? { user: { id: token } } : { user: null } }) },
  } as unknown as SupabaseClient;
}

function blogDeps(ai: Ai, opts: { refuse?: string | null; calls?: Call[] } = {}): Deps {
  const calls = opts.calls ?? [];
  return { ...deps({ calls, ai }), asCaller: blogCaller(HIT, opts.refuse ?? null, calls), projectUrl: "https://p.supabase.co" };
}

Deno.test("a news post's translation keeps the format's marks, or it is dropped", () => {
  const src = "## Novinky\n- jeden\n1. krok\n> citat **tucne**\n[[foto:" + P1 + "]]";
  ok(keepsText("blog_body", src, "## News\n- one\n1. step\n> quote **bold**\n[[foto:" + P1 + "]]"), "all marks kept");
  ok(!keepsText("blog_body", src, "## News\n- one\n1. step\n> quote bold\n[[foto:" + P1 + "]]"), "a lost bold pair");
  ok(!keepsText("blog_body", src, "## News\n- one\n1. step\n> quote **bold**"), "a lost photo line");
  ok(!keepsText("blog_body", src, "News\n- one\n1. step\n> quote **bold**\n[[foto:" + P1 + "]]"), "a lost subheading");
  ok(keepsText("item_name", "- farba", "paint"), "other kinds: only {placeholders}");
});

Deno.test("Opraviť gramatiku: words only — the same numbers, links, marks and lines (mocked AI)", async () => {
  ok(keepsFacts(BODY, BODY.replace("akrylove", "akrylové").replace("cierna", "čierna")), "accents fixed");
  ok(!keepsFacts(BODY, BODY.replace("12,50", "12,90")), "a changed price");
  ok(!keepsFacts(BODY, BODY.replace("https://farby.sk/akcia", "https://farby.sk")), "a changed link");
  ok(!keepsFacts(BODY, BODY.replace("- biela\n", "")), "a lost line");
  ok(!keepsFacts(BODY, BODY.replace("**cierna**", "cierna")), "a lost mark");
  const calls: Call[] = [];
  const good: Ai = (_s, user) => {
    const { title, text } = JSON.parse(String(user));
    return Promise.resolve({ json: { title: title.replace("Novinky", "Novinky!"), body: text.replace("akrylove", "akrylové"), language: "sk" }, input: 300, output: 200 });
  };
  const res = await handle(post({ action: "blog_fix", post_id: POST, title: "Novinky", body: BODY }, { Authorization: "Bearer owner" }), blogDeps(good, { calls }));
  eq(res.status, 200, "fixed");
  const out = await res.json();
  eq([out.title, out.body.includes("akrylové farby za 12,50 €"), out.left], ["Novinky!", true, 19], "the corrected text, not saved");
  ok(calls.some((c) => c.fn === "owner_blog_ai_hit" && c.args.p_post_id === POST), "the door first");
  ok(calls.some((c) => c.fn === "translation_spend"), "the monthly AI spend");
  ok(calls.some((c) => c.fn === "owner_ai_spend" && c.args.p_kind === "blog" && c.args.p_input === 300), "the shop's AI spend");
  ok(!calls.some((c) => c.fn.startsWith("owner_blog_save") || c.fn === "owner_blog_own_text"), "nothing saved");
  const sly: Ai = (_s, user) => {
    const { title, text } = JSON.parse(String(user));
    return Promise.resolve({ json: { title, body: text.replace("12,50", "9,90"), language: "sk" }, input: 1, output: 1 });
  };
  const refused = await handle(post({ action: "blog_fix", post_id: POST, title: "Novinky", body: BODY }, { Authorization: "Bearer owner" }), blogDeps(sly));
  eq([refused.status, (await refused.json()).error], [502, "structure"], "a changed price is never returned");
});

Deno.test("Skrášliť článok: only this post's photos (not the cover), each once; no new numbers or links; ±20 %", async () => {
  const pretty = "Akrylove farby su tu.\n\n## Co mame\n- biela\n- **cierna**\n\n[[foto:" + P2 + "]]\n\nOd 3. 11. za 12,50 €, viac na https://farby.sk/akcia";
  eq(checkBeautified(BODY, pretty, [P2, P3], "Farby Budince"), pretty, "kept as it is");
  const twice = pretty + "\n[[foto:" + P2 + "]]\n[[foto:" + P1 + "]]\n[[foto:99999999-2222-4333-8444-555555555555]]";
  const cleaned = checkBeautified(BODY, twice, [P2, P3], "Farby Budince");
  eq((cleaned ?? "").match(/\[\[foto:/g)?.length, 1, "the cover, an unknown id and a second use are dropped");
  eq(checkBeautified(BODY, pretty.replace("12,50", "11,50"), [P2], ""), null, "a new number");
  eq(checkBeautified(BODY, pretty + " Volajte 0905 999 888.", [P2], ""), null, "an invented phone number");
  ok(checkBeautified(BODY, pretty + "\n\nVolajte +421 905 123 456.", [P2], HIT.shop.phone) !== null, "the shop's own phone is a fact");
  eq(checkBeautified(BODY, pretty + " https://iny.sk", [P2], ""), null, "a new link");
  eq(checkBeautified(BODY, pretty + " " + "slovo ".repeat(60), [P2], ""), null, "too long");
  eq(numbersOf("1. krok\n2. krok za 5 €"), ["5"], "a numbered list's numbers are structure");

  let seen: unknown[] = [];
  const ai: Ai = (system, user) => {
    seen = user as unknown[];
    ok(system.includes("each at most once") && system.includes("never invent"), "the rules");
    return Promise.resolve({ json: { title_suggestion: "Akrylové farby za 12,50 €", body: pretty, language: "sk" }, input: 2000, output: 400 });
  };
  const res = await handle(post({ action: "blog_beautify", post_id: POST, title: "Novinky", body: BODY, style: "sales" }, { Authorization: "Bearer owner" }), blogDeps(ai));
  eq(res.status, 200, "beautified");
  const out = await res.json();
  eq([out.title_suggestion, out.body, out.photos], ["Akrylové farby za 12,50 €", pretty, 2], "the new text, two photos offered");
  const pictures = seen.filter((b) => (b as { type: string }).type === "image") as { source: { url: string } }[];
  eq(pictures.map((p) => p.source.url), ["https://p.supabase.co/storage/v1/object/public/blog-photos/a/b/d-800.webp", "https://p.supabase.co/storage/v1/object/public/blog-photos/a/b/e-800.webp"], "the cover is not offered");
});

Deno.test("the blog AI's door: login, plan, limit, another owner's post", async () => {
  const ai: Ai = () => Promise.reject(new Error("never called"));
  const call = (refuse: string | null, auth = "Bearer owner") =>
    handle(post({ action: "blog_fix", post_id: POST, title: "T", body: BODY }, { Authorization: auth }), blogDeps(ai, { refuse }));
  eq((await call(null, "Bearer nobody")).status, 401, "not logged in");
  eq([(await call("no_plan")).status, (await (await call("no_plan")).json()).error], [403, "no_plan"], "free shops: Dostupné v Pro");
  eq((await (await call("blog_ai_limit")).json()).error, "ai_limit", "today's limit");
  eq((await (await call("blog_ai_off")).json()).error, "ai_off", "switched off by the admin");
  eq((await call("Not your shop")).status, 403, "another owner's post");
  eq((await handle(post({ action: "blog_fix", post_id: "x", body: "y" }, { Authorization: "Bearer owner" }), blogDeps(ai))).status, 400, "a bad id");
});
