// Unit tests of the languages (update 40): the list, the browser's language, the picker's search and addresses, the
// fallback of interface texts (never a key name) and the three hand-written message files.
// Run: npm run test:i18n
import { fold, fromAcceptLanguage, HANDWRITTEN, LANGUAGES, languageMatches, languageOf, MAIN_RECOMMENDED, pickerPath } from "./languages.ts";
import { flatten, isLegalKey, layered, placeholders } from "./messages.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}
function ok(value: unknown, label: string) {
  if (!value) throw new Error(label);
}

const read = async (lang: string) => JSON.parse(await Deno.readTextFile(new URL(`./messages/${lang}.json`, import.meta.url))) as Record<string, unknown>;

Deno.test("every EU language, the other European ones, Chinese and Vietnamese; Russian and regional ones off", () => {
  const codes = LANGUAGES.map((l) => l.code);
  for (const c of ["sk", "hu", "en", "cs", "pl", "de", "uk", "ro", "hr", "sl", "bg", "el", "it", "fr", "es", "pt", "nl", "da", "sv", "fi", "et", "lv", "lt", "ga", "mt"]) ok(codes.includes(c as never), `EU ${c}`);
  for (const c of ["nb", "is", "sr", "sr-cyrl", "bs", "sq", "mk", "tr", "ru", "ca", "eu", "gl", "cy", "lb", "zh-hans", "zh-hant", "vi"]) ok(codes.includes(c as never), `other ${c}`);
  eq(new Set(codes).size, codes.length, "no code twice");
  eq(LANGUAGES.filter((l) => !l.enabledByDefault).map((l) => l.code), ["ru", "ca", "eu", "gl", "cy", "lb", "zh-hant"], "off by default");
  eq(LANGUAGES.filter((l) => l.group === "other").map((l) => l.code), ["zh-hans", "zh-hant", "vi"], "Ďalšie jazyky");
  eq(MAIN_RECOMMENDED, ["sk", "hu", "en", "cs", "uk", "pl", "de"], "Odporúčané on PPI");
  for (const l of LANGUAGES) ok(new Intl.Locale(l.code).baseName, `${l.code} is a valid tag for Intl`);
  ok(new Intl.NumberFormat("zh-hans", { style: "currency", currency: "EUR" }).format(1.5), "Intl formats Chinese");
  eq(languageOf("el")?.script, "greek", "Greek needs the Noto fallback");
  eq(languageOf("vi")?.script, "latin", "Vietnamese is in Quicksand's vietnamese subset");
});

Deno.test("the browser's language: first switched-on one, regional variants and scripts", () => {
  const on = ["sk", "hu", "en", "de", "zh-hans", "zh-hant", "nb", "sr-cyrl", "uk"];
  eq(fromAcceptLanguage("de-AT,de;q=0.9,en;q=0.8", on), "de", "de-AT → de");
  eq(fromAcceptLanguage("zh-TW,zh;q=0.9", on), "zh-hant", "Taiwan → Traditional");
  eq(fromAcceptLanguage("zh-CN", on), "zh-hans", "China → Simplified");
  eq(fromAcceptLanguage("no-NO", on), "nb", "no → nb");
  eq(fromAcceptLanguage("sr-Cyrl-RS", on), "sr-cyrl", "Serbian Cyrillic");
  eq(fromAcceptLanguage("ru-RU,ru;q=0.9,uk;q=0.8", on), "uk", "Russian off: the next one");
  eq(fromAcceptLanguage("fr-FR;q=0.9,ja;q=1", on), null, "none switched on → the caller uses Slovak");
  eq(fromAcceptLanguage("", on), null, "no header");
});

Deno.test("the picker's search knows own, English, Slovak and Hungarian names", () => {
  const find = (q: string) => LANGUAGES.filter((l) => languageMatches(l, q)).map((l) => l.code);
  ok(find("chinese").includes("zh-hans") && find("čínština").includes("zh-hant") && find("kínai").includes("zh-hans"), "Chinese");
  eq(find("deutsch"), ["de"], "own name");
  eq(find("nemcina"), ["de"], "Slovak without accents");
  ok(find("Ελληνικά").includes("el"), "Greek letters");
  eq(fold("Čeština"), "cestina", "fold");
});

Deno.test("the picker's links: PPI's paths, an own domain's home language at /", () => {
  eq(pickerPath("/sk/shops/potraviny", "de", "sk", null), "/de/shops/potraviny", "PPI");
  eq(pickerPath("/sk", "zh-hans", "sk", null), "/zh-hans", "home");
  const site = { homeLang: "hu" };
  eq(pickerPath("/", "de", "hu", site), "/de", "domain home → /de");
  eq(pickerPath("/de", "hu", "de", site), "/", "back to the home language");
  eq(pickerPath("/de/items/abc", "hu", "de", site), "/hu/items/abc", "items keep their prefix");
  eq(pickerPath("/blog/post-1", "el", "hu", site), "/el/blog/post-1", "blog");
  eq(pickerPath("/site/de/shop/blog", "hu", "de", site), "/blog", "the internal address");
});

Deno.test("interface texts: SK ← EN ← own ← database; never a key name; legal keys", () => {
  const sk = { shop: { hours: "Otváracie hodiny", save: "Uložiť", count: "{n} ks" } };
  const en = flatten({ shop: { hours: "Opening hours", save: "Save", count: "{n} pcs" } });
  const db = { "shop.hours": "Öffnungszeiten", "shop.unknown": "x", "shop.save": "" };
  eq(layered(sk, en, null, db), { shop: { hours: "Öffnungszeiten", save: "Save", count: "{n} pcs" } }, "German: database, else English");
  eq(layered(sk, null, null, null), sk, "Slovak alone");
  eq(placeholders("Zostáva {n} z {all}"), ["all", "n"], "placeholders");
  ok(isLegalKey("privacy.title") && isLegalKey("terms.intro") && !isLegalKey("shop.hours"), "legal keys");
});

Deno.test("the hand-written files have the same keys and placeholders", async () => {
  const [sk, hu, en] = await Promise.all(HANDWRITTEN.map(read));
  const s = flatten(sk as never) as Record<string, string>;
  for (const [name, other] of [["hu", hu], ["en", en]] as const) {
    const o = flatten(other as never) as Record<string, string>;
    eq(Object.keys(o).filter((k) => !(k in s)), [], `${name}: no extra keys`);
    eq(Object.keys(s).filter((k) => !(k in o)), [], `${name}: no missing keys`);
    const wrong = Object.keys(s).filter((k) => JSON.stringify(placeholders(s[k])) !== JSON.stringify(placeholders(o[k] ?? "")));
    eq(wrong, [], `${name}: the same {placeholders}`);
  }
});
