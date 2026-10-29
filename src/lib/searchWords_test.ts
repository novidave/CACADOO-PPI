import { assertEquals } from "jsr:@std/assert@1";
import { highlightParts, searchStem, searchText, wordMatches } from "./searchWords.ts";

// The same stems public.search_stem() gives (database update 54; values read from the SQL function).
const SQL_STEMS: [string, string][] = [
  ["Akrylové", "akril"], ["akrylový", "akril"], ["acrylic", "akril"], ["akril", "akril"], ["Budinciach", "budink"],
  ["Budince", "budink"], ["médium", "medium"], ["lesklé", "leskl"], ["farby", "farb"], ["festék", "fest"],
  ["Mercedes", "merked"], ["mercedez", "merkedez"], ["fényes", "feni"], ["glossy", "gloss"], ["0,5", "0,5"],
  ["775", "775"], ["Štetec", "stetek"], ["Riedidlo", "riedidl"], ["paints", "paint"], ["Michalovciach", "mikhalovk"],
  ["Kávé", "kave"], ["Phosphor", "fosfor"], ["Packung", "pakung"],
];

Deno.test("searchStem gives the same stems as public.search_stem()", () => {
  for (const [word, stem] of SQL_STEMS) assertEquals(searchStem(word), stem, word);
});

Deno.test("searchText: lower case without accents", () => {
  assertEquals(searchText("Akrylové MÉDIUM Łódź Straße"), "akrylove medium lodz strasse");
});

Deno.test("wordMatches: same word, beginning, typo; numbers only exactly", () => {
  assertEquals(wordMatches("Akrylové", ["akril"]), true);
  assertEquals(wordMatches("médium", ["med"]), true, "a beginning");
  assertEquals(wordMatches("Mercedes", ["merkedez"]), true, "typo");
  assertEquals(wordMatches("775", ["775"]), true);
  assertEquals(wordMatches("776", ["775"]), false, "numbers never by typo");
  assertEquals(wordMatches("Štetec", ["akril"]), false);
});

Deno.test("highlightParts marks the matched words and keeps the text as written", () => {
  const parts = highlightParts("Akrylové médium lesklé, 250 ml", ["akril", "medium"]);
  assertEquals(parts.map((p) => p.text).join(""), "Akrylové médium lesklé, 250 ml");
  assertEquals(parts.filter((p) => p.hit).map((p) => p.text), ["Akrylové", "médium"]);
  assertEquals(highlightParts("Štetec", []), [{ text: "Štetec", hit: false }]);
});
