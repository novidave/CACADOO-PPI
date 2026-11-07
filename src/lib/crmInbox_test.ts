// CRM → Konverzácie, the two-pane inbox (2026-11-07). Run: npm run test:conversations
import { assert, assertEquals } from "jsr:@std/assert@1";
import { dayIn, defaultOpen, draftKey, draftWords, hasVariable, inboxHref, rowTags, shopLanguage, timeWord } from "./crmInbox.ts";

const TZ = "Europe/Bratislava";
const NOW = Date.parse("2026-11-07T13:30:00Z"); // 14:30 in Bratislava

Deno.test("the row's time: today HH:MM, včera, else the date — in the shop's time zone", () => {
  assertEquals(timeWord("2026-11-07T13:05:00Z", NOW, TZ, "sk"), { kind: "time", text: "14:05" });
  assertEquals(timeWord("2026-11-06T23:30:00Z", NOW, TZ, "sk"), { kind: "time", text: "00:30" }, "after midnight there = today");
  assertEquals(timeWord("2026-11-06T22:30:00Z", NOW, TZ, "sk"), { kind: "yesterday" }, "23:30 there = yesterday");
  const older = timeWord("2026-11-02T09:00:00Z", NOW, TZ, "sk");
  assertEquals(older.kind, "date");
  assert(older.kind === "date" && older.text.includes("2") && older.text.includes("11") && !older.text.includes("2026"), older.kind === "date" ? older.text : "");
  const lastYear = timeWord("2025-12-30T09:00:00Z", NOW, TZ, "sk");
  assert(lastYear.kind === "date" && lastYear.text.includes("2025"));
  // another zone: the same instant is a different day
  assertEquals(dayIn("2026-11-06T23:30:00Z", "Europe/Lisbon"), "2026-11-06");
  assertEquals(dayIn("2026-11-06T23:30:00Z", TZ), "2026-11-07");
});

Deno.test("the row's tags in their order; the language only when it differs from the shop's", () => {
  const base = { waiting: false, next_booking_at: null, shopper_lang: "sk", page_lang: "sk", starred: false, status: "read", draft_text: null };
  assertEquals(rowTags(base, "sk"), []);
  assertEquals(
    rowTags({ ...base, waiting: true, next_booking_at: "2026-11-13T09:30:00Z", shopper_lang: "hu", starred: true, status: "new", draft_text: "Dobrý" }, "sk")
      .map((t) => t.kind),
    ["waiting", "booking", "lang", "star", "new", "draft"],
  );
  assertEquals(rowTags({ ...base, shopper_lang: "hu" }, "sk"), [{ kind: "lang", code: "HU" }]);
  assertEquals(rowTags({ ...base, shopper_lang: null, page_lang: "en" }, "sk"), [{ kind: "lang", code: "EN" }], "the page language when unknown");
  assertEquals(rowTags({ ...base, draft_text: "   " }, "sk"), [], "an empty draft is no draft");
  assertEquals(shopLanguage("HU"), "hu");
  assertEquals(shopLanguage("SK", "de"), "de");
  assertEquals(shopLanguage("XX"), "en");
});

Deno.test("the draft's first words: folded, cut at a word with …", () => {
  assertEquals(draftWords("Dobrý   deň,\n lazúru"), "Dobrý deň, lazúru");
  assertEquals(draftWords("Dobrý deň, lazúru Osmo vieme objednať do piatku, ozveme sa vám", 30), "Dobrý deň, lazúru Osmo vieme…");
  assertEquals(draftWords(null), "");
  assertEquals(draftWords("x".repeat(60), 10), `${"x".repeat(10)}…`, "one long word is cut");
  assertEquals(draftKey("abc"), "ppi.crm.draft.abc");
});

Deno.test("which conversation opens; every row's address keeps the list's query", () => {
  assertEquals(defaultOpen([{ id: "a", waiting: false }, { id: "b", waiting: true }]), "b");
  assertEquals(defaultOpen([{ id: "a", waiting: false }]), "a");
  assertEquals(defaultOpen([]), null);
  assertEquals(inboxHref("/sk/dashboard/crm", { shop: "davide", f: "waiting", cq: "" }, "x1"), "/sk/dashboard/crm?shop=davide&f=waiting&c=x1");
  assertEquals(inboxHref("/sk/dashboard/crm", { shop: "davide", c: "old" }, null), "/sk/dashboard/crm?shop=davide");
});

Deno.test("Náhľad only when the text holds a variable", () => {
  assert(hasVariable("Dobrý deň {meno}"));
  assert(hasVariable("Volajte {{shop_phone}}"));
  assert(!hasVariable("Dobrý deň, RAL 7016 namiešame."));
});
