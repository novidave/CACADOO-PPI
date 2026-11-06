// Unit tests (Deno) of "Ignorované produkty" (database update 88): the screen's words — plurals, the stock word, the
// code line, the delete button (ticks vs. everything the list shows, never the "similar" rows), select all, the
// shop-name check, the line after "Obnoviť", the refusals as texts — and the same keys in sk/hu/en. npm run test:items
import sk from "../i18n/messages/sk.json" with { type: "json" };
import hu from "../i18n/messages/hu.json" with { type: "json" };
import en from "../i18n/messages/en.json" with { type: "json" };
import { codeLine, deleteButton, errorKey, nameConfirmed, pluralKey, restoredKey, selectAllLabel, stockWord, toggle, TOAST_MS } from "./ignoredItems.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

Deno.test("plurals: 1 produkt, 3 produkty, 5 produktov (Slovak); one / other in Hungarian and English", () => {
  eq([1, 2, 4, 5, 11, 0].map((n) => pluralKey(n, "sk")), ["one", "few", "few", "other", "other", "other"], "sk");
  eq([1, 2, 5].map((n) => pluralKey(n, "en")), ["one", "other", "other"], "en");
  eq([1, 3].map((n) => pluralKey(n, "hu")), ["one", "other"], "hu");
  eq(pluralKey(3, "xx-invalid-!!"), "other", "an unknown language never throws");
  const t = (n: number) => (sk.ignored as Record<string, string>)[`dialog_title_${pluralKey(n, "sk")}`].replace("{n}", String(n));
  eq([t(1), t(3), t(5)], ["Vymazať 1 produkt zo stránky?", "Vymazať 3 produkty zo stránky?", "Vymazať 5 produktov zo stránky?"], "dialog");
});

Deno.test("the stock word: pieces, sold out, or hidden when the data are stale", () => {
  eq(stockWord(12, false), { key: "stock_n", n: 12 }, "in stock");
  eq(stockWord(0, false), { key: "sold_out", n: 0 }, "0 = sold out");
  eq(stockWord(-3, false), { key: "sold_out", n: 0 }, "below 0 = sold out");
  eq(stockWord(null, false), { key: "sold_out", n: 0 }, "no row = sold out");
  eq(stockWord(12, true), { key: "stale", n: 0 }, "stale data: hidden, never a quantity");
});

Deno.test("the code line: the code always, the EAN when there is one", () => {
  const l = { code: "Kód {code}", ean: "EAN {ean}" };
  eq(codeLine("A1", "8580000000011", l), "Kód A1 · EAN 8580000000011", "both");
  eq(codeLine("A1", null, l), "Kód A1", "no EAN");
});

Deno.test("the delete button: ticks first, else everything the list shows; nothing for similar-only rows", () => {
  eq(deleteButton(3, 40), { all: false, n: 3, disabled: false }, "ticked");
  eq(deleteButton(0, 40), { all: true, n: 40, disabled: false }, "all");
  eq(deleteButton(0, 0), { all: true, n: 0, disabled: true }, "similar rows only / empty");
});

Deno.test("select all ↔ clear, toggling keeps the old set", () => {
  const ids = ["a", "b"];
  eq(selectAllLabel(ids, new Set()), "select_all", "none");
  eq(selectAllLabel(ids, new Set(["a"])), "select_all", "some");
  eq(selectAllLabel(ids, new Set(["a", "b"])), "select_none", "all");
  eq(selectAllLabel([], new Set()), "select_all", "empty list");
  const before = new Set(["a"]);
  const after = toggle(before, "b");
  eq([[...before], [...after].sort()], [["a"], ["a", "b"]], "a new set");
  eq([...toggle(after, "a")], ["b"], "off again");
});

Deno.test("the shop's name: case and outer spaces ignored, never an empty name", () => {
  eq(nameConfirmed("  farby ignore ", "Farby Ignore"), true, "case and spaces");
  eq(nameConfirmed("Farby", "Farby Ignore"), false, "a part");
  eq(nameConfirmed("", "  "), false, "empty");
});

Deno.test("after Obnoviť: the next file, the till's or the program's sync", () => {
  eq([restoredKey("file"), restoredKey("agent"), restoredKey("api"), restoredKey(undefined)], ["restored", "restored_agent", "restored_api", "restored"], "keys");
});

Deno.test("refusals as texts", () => {
  eq(errorKey("changed"), "err_changed", "changed");
  eq(errorKey("too_many"), "err_too_many", "too many");
  eq(errorKey("nothing_to_remove"), "err_nothing", "nothing");
  eq(errorKey("sklad_source"), "sklad_note", "sklad");
  eq(errorKey("restore_newer_upload"), "err_undo", "undo after a file");
  eq(errorKey("Not a member of this shop"), "err_failed", "anything else");
  eq(TOAST_MS, 8000, "the toast stays 8 s");
});

Deno.test("the same keys and placeholders in sk / hu / en; every key the rules name exists", () => {
  const keys = (o: Record<string, string>) => Object.keys(o).sort();
  const s = sk.ignored as Record<string, string>;
  eq(keys(hu.ignored as Record<string, string>), keys(s), "hu keys");
  eq(keys(en.ignored as Record<string, string>), keys(s), "en keys");
  const marks = (t: string) => (t.match(/\{\w+\}/g) ?? []).sort().join();
  for (const k of keys(s)) {
    for (const [lang, d] of [["hu", hu], ["en", en]] as const) {
      eq(marks((d.ignored as Record<string, string>)[k]), marks(s[k]), `${lang}.${k} placeholders`);
    }
  }
  for (const k of ["err_changed", "err_too_many", "err_nothing", "err_undo", "err_failed", "err_name", "sklad_note", "restored", "restored_agent", "restored_api", "stock_n", "sold_out", "stale", "select_all", "select_none"]) {
    if (!(k in s)) throw new Error(`missing ignored.${k}`);
  }
  for (const d of [sk, hu, en]) {
    if (!("ignored" in d.imports) || !("activity_items_ignored" in d.reset)) throw new Error("imports.ignored / reset.activity_items_ignored");
  }
});
