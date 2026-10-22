// Unit tests (Deno) of Môj obchod → Jazyky a inventár → "Tovar" (database update 41): what the column "Čo vidí
// zákazník" says in each state (stale → hidden with the reason, sold out, in stock with the file's quantity), the
// filters from the address, their counts and the status line of the last file. Run: npm run test:items
import sk from "../i18n/messages/sk.json" with { type: "json" };
import hu from "../i18n/messages/hu.json" with { type: "json" };
import en from "../i18n/messages/en.json" with { type: "json" };
import { fileStatus, filterCount, ITEM_FILTERS, itemFilter, shopperView } from "./ownerItems.ts";
import { availabilityText } from "./stock.ts";
import type { Dictionary } from "../i18n/dictionaries.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

const dicts = { sk, hu, en } as unknown as Record<"sk" | "hu" | "en", Dictionary>;

Deno.test("Čo vidí zákazník: stale data is hidden with the reason, never a dash", () => {
  eq(shopperView(null), "hidden_stale", "no availability from the database = stale");
  for (const [lang, dict] of Object.entries(dicts)) {
    // the database gives no label while stale, so there is no shopper text to show …
    eq(availabilityText(dict, null, 22, lang), null, `${lang}: no shopper text`);
    // … and the column says why, with the way out
    const reason = (dict.dashboard as Record<string, string>).shopper_hidden_stale;
    eq(Boolean(reason) && reason !== "–" && /24/.test(reason), true, `${lang}: reason with 24 h`);
    eq(Boolean((dict.dashboard as Record<string, string>).upload_new_file), true, `${lang}: upload link text`);
  }
  eq(dicts.sk.dashboard.shopper_hidden_stale, "Skryté – údaje sú staršie ako 24 h", "the Slovak text");
});

Deno.test("Čo vidí zákazník: sold out is \"Vypredané\" (at 0 or less, as the database says)", () => {
  eq(shopperView("out_of_stock"), "sold_out", "view");
  eq(availabilityText(dicts.sk, "out_of_stock", 0, "sk"), "Vypredané", "sk");
  eq(availabilityText(dicts.sk, "out_of_stock", -3, "sk"), "Vypredané", "less than 0");
  eq(availabilityText(dicts.hu, "out_of_stock", 0, "hu"), dicts.hu.stock.out_of_stock, "hu");
});

Deno.test("Čo vidí zákazník: in stock is the shopper's exact text with the file's quantity", () => {
  eq(shopperView("in_stock_count"), "in_stock", "view");
  eq(availabilityText(dicts.sk, "in_stock_count", 22, "sk"), "22 ks na sklade", "sk");
  eq(availabilityText(dicts.sk, "in_stock_count", 12.5, "sk"), "12,5 ks na sklade", "decimals as in the file, Slovak comma");
  eq(availabilityText(dicts.en, "in_stock_count", 12.5, "en")?.startsWith("12.5"), true, "English point");
});

Deno.test("filters: from the address, anything unknown is Všetko; counts from the database", () => {
  eq([...ITEM_FILTERS], ["all", "in_stock", "sold_out", "no_description", "missing_translation"], "the five filters in order");
  eq(itemFilter(undefined), "all", "none");
  eq(itemFilter("sold_out"), "sold_out", "known");
  eq(itemFilter(["missing_translation", "x"]), "missing_translation", "first of many");
  eq(itemFilter("hidden"), "all", "unknown");
  const counts = { all_items: 14, in_stock: 4, sold_out: 10, no_description: 13, missing_translation: 2 };
  eq(ITEM_FILTERS.map((f) => filterCount(counts, f)), [14, 4, 10, 13, 2], "counts per filter");
  eq(filterCount(null, "all"), null, "before update 41: no counts");
  for (const [lang, dict] of Object.entries(dicts)) {
    for (const f of ITEM_FILTERS) {
      eq(Boolean((dict.dashboard as Record<string, string>)[`filter_${f}`]), true, `${lang}: filter_${f}`);
    }
  }
  eq(ITEM_FILTERS.map((f) => (dicts.sk.dashboard as Record<string, string>)[`filter_${f}`]), ["Všetko", "Na sklade", "Vypredané", "Bez popisu", "Chýba preklad"], "Slovak names");
});

Deno.test("status line: the last file with aktuálny / starší / zastaraný, or no file yet", () => {
  eq(fileStatus(null, "stale"), { kind: "none" }, "no file");
  eq(fileStatus("2026-10-22T08:00:00Z", "current"), { kind: "file", at: "2026-10-22T08:00:00Z", state: "current" }, "current");
  eq(fileStatus("2026-10-22T08:00:00Z", "recent"), { kind: "file", at: "2026-10-22T08:00:00Z", state: "recent" }, "recent");
  eq(fileStatus("2026-10-20T08:00:00Z", null), { kind: "file", at: "2026-10-20T08:00:00Z", state: "stale" }, "unknown → stale");
  const d = dicts.sk.dashboard as Record<string, string>;
  eq([d.file_state_current, d.file_state_recent, d.file_state_stale], ["aktuálny", "starší", "zastaraný"], "Slovak words");
  eq(d.file_status.includes("{time}"), true, "time placeholder");
});

Deno.test("one short line + Viac, the old explanations and the correction dropdown are gone", () => {
  eq(dicts.sk.dashboard.items_intro,
    "Množstvá zobrazujeme presne podľa vášho skladového súboru. Názvy a popisy prekladáme automaticky; vaše úpravy prekladov neprepisujeme.",
    "the line");
  for (const [lang, dict] of Object.entries(dicts)) {
    const d = dict.dashboard as Record<string, string>;
    for (const gone of ["items_hint", "translation_hint", "translation_edit", "translation_yours", "translation_save"]) {
      eq(d[gone], undefined, `${lang}: ${gone} removed`);
    }
    eq(Boolean(d.items_more && d.items_more_text && d.shopper_sees), true, `${lang}: new texts`);
  }
  eq(dicts.sk.dashboard.shopper_sees, "Čo vidí zákazník", "column");
});
