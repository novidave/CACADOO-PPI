// Unit tests of the variable tags and "Opraviť gramatiku" (CRM → Správy, 2026-11-04). Run: npm run test:crm
import {
  fixGrammarWith,
  insertToken,
  keepsStructure,
  smsCompare,
  tagPieces,
  unknownVariables,
  withoutAccents,
  wordDiff,
} from "./messageTags.ts";

function eq(actual: unknown, expected: unknown, what: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("a tag goes in at the cursor, with a space where it would touch a word", () => {
  eq(insertToken("Dobrý deň ", 10, 10, "{meno}"), { text: "Dobrý deň {meno}", caret: 16 }, "after a space");
  eq(insertToken("Dobrý deň,", 9, 9, "{meno}"), { text: "Dobrý deň {meno},", caret: 16 }, "before a comma");
  eq(insertToken("Ahoj", 0, 0, "{meno}"), { text: "{meno} Ahoj", caret: 6 }, "at the start, before a word");
  eq(insertToken("", 0, 0, "{obchod}"), { text: "{obchod}", caret: 8 }, "empty text");
});

Deno.test("a tag replaces the selection; a drop point is a cursor at that index", () => {
  eq(insertToken("Dobrý deň Ján, …", 10, 13, "{meno}"), { text: "Dobrý deň {meno}, …", caret: 16 }, "selection replaced");
  // dropped between "na" and "15:00" (index 8 of "Príďte na 15:00")
  eq(insertToken("Príďte na 15:00", 10, 10, "{cas}"), { text: "Príďte na {cas} 15:00", caret: 15 }, "drop point");
  eq(insertToken("abc", 99, 99, "{cas}"), { text: "abc {cas}", caret: 9 }, "past the end = the end");
  eq(insertToken("abc", 2, 1, "{cas}"), { text: "a {cas} c", caret: 7 }, "a backwards selection");
});

Deno.test("unknown variables are named once; the known ones show as tags", () => {
  eq(unknownVariables("Ahoj {meno}, {xyz} a {xyz} – {{shop_web}} {{meno}} {Obchod}"), ["{xyz}", "{{meno}}"], "unknown");
  eq(unknownVariables("{{ shop_phone }} {{name}} {cas}"), [], "spaces and the older names are fine");
  eq(tagPieces("Ahoj {meno}! {nie}"), [
    { text: "Ahoj " }, { text: "{meno}", tag: "known" }, { text: "! " }, { text: "{nie}", tag: "unknown" },
  ], "pieces");
});

Deno.test("a correction must keep every variable and line break", () => {
  eq(keepsStructure("Ahoj {meno},\n\nvaša objednavka", "Ahoj {meno},\n\nvaša objednávka"), true, "fixed word");
  eq(keepsStructure("Ahoj {meno}", "Ahoj meno"), false, "variable lost");
  eq(keepsStructure("Ahoj {meno}", "Ahoj {meno} {meno}"), false, "variable doubled");
  eq(keepsStructure("a\nb", "a b"), false, "line break lost");
  eq(keepsStructure("{{ shop_web }}", "{{shop_web}}"), true, "spaces inside a variable do not matter");
});

Deno.test("Opraviť gramatiku: the AI's text only when the structure stayed (mocked AI)", async () => {
  const good = await fixGrammarWith(async (i) => ({ text: i.text.replace("objednavka", "objednávka"), subject: i.subject ?? null, language: "sk" }), {
    text: "Dobrý deň {meno},\nvaša objednavka je pripravená.",
    channel: "sms",
  });
  eq(good, { ok: true, text: "Dobrý deň {meno},\nvaša objednávka je pripravená.", subject: null, language: "sk", usage: { input: 0, output: 0 } }, "kept");
  const lost = await fixGrammarWith(async () => ({ text: "Dobrý deň Ján, vaša objednávka je pripravená.", subject: null, language: "sk" }), {
    text: "Dobrý deň {meno},\nvaša objednavka je pripravená.",
    channel: "sms",
  });
  eq(lost, { ok: false, reason: "structure" }, "a variable or a line went missing");
  const subject = await fixGrammarWith(async (i) => ({ text: i.text, subject: "Objednávka {cas}", language: "sk" }), {
    text: "Text",
    subject: "Objednavka",
    channel: "email",
  });
  eq(subject, { ok: false, reason: "structure" }, "the subject got a variable it did not have");
  eq(await fixGrammarWith(async () => ({ text: "x", subject: null, language: "sk" }), { text: "  ", channel: "sms" }), { ok: false, reason: "empty" }, "empty");
});

Deno.test("the changed words are marked", () => {
  eq(wordDiff("vaša objednavka je hotova", "vaša objednávka je hotová"), [
    { text: "vaša ", changed: false }, { text: "objednávka", changed: true }, { text: " je ", changed: false }, { text: "hotová", changed: true },
  ], "two words");
  eq(wordDiff("a b", "a b"), [{ text: "a b", changed: false }], "nothing changed");
});

Deno.test("SMS parts before and after; Bez diakritiky keeps the variables", () => {
  const plainText = "Dobry den {meno}, vasa objednavka je pripravena na vyzdvihnutie v obchode {obchod}. Dakujeme!";
  const accents = "Dobrý deň {meno}, vaša objednávka je pripravená na vyzdvihnutie v obchode {obchod}. Ďakujeme!";
  const c = smsCompare(plainText, accents);
  eq([c.before.parts, c.before.unicode, c.after.parts, c.after.unicode, c.accentsCost], [1, false, 2, true, true], "accents add a part");
  eq(withoutAccents(accents), "Dobry den {meno}, vasa objednavka je pripravena na vyzdvihnutie v obchode {obchod}. Dakujeme!", "no accents");
  eq(withoutAccents("Ő {{shop_web}} ű"), "O {{shop_web}} u", "Hungarian");
  eq(smsCompare("Ahoj", "Ahoj!").accentsCost, false, "no accents, nothing to offer");
});
