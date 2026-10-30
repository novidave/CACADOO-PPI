// Unit tests of the owner's conversation exports (update 55). Run: npm run test:conversations
import { conversationTxt, csvCell, exportCsv, exportName, localStamp, toCsv, type ExportRow } from "./conversationExport.ts";

function eq(actual: unknown, expected: unknown, what: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("times in the shop's time zone, also across the change to winter time", () => {
  eq(localStamp("2026-10-30T13:05:00Z", "Europe/Bratislava"), "2026-10-30 14:05", "winter time");
  eq(localStamp("2026-07-01T22:30:00Z", "Europe/Bratislava"), "2026-07-02 00:30", "summer time, next day");
  eq(localStamp("2026-07-01T22:30:00Z", "Europe/Lisbon"), "2026-07-01 23:30", "another zone");
});

Deno.test("CSV cells: quotes, separators, new lines and formulas", () => {
  eq(csvCell("Granko"), "Granko", "plain");
  eq(csvCell('povedal "áno"'), '"povedal ""áno"""', "quotes");
  eq(csvCell("a;b"), '"a;b"', "separator");
  eq(csvCell("riadok 1\nriadok 2"), '"riadok 1\nriadok 2"', "new line");
  eq(csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"", "a formula is never run");
  eq(csvCell("+421 900 000 000"), "'+421 900 000 000", "a phone number stays text");
  eq(csvCell("-5"), "'-5", "minus");
  eq(csvCell(null), "", "null");
  eq(csvCell(0), "0", "zero");
});

Deno.test("the CSV starts with a BOM and ends every line with CRLF", () => {
  const csv = toCsv(["A", "B"], [["1", "2"]]);
  eq(csv.charCodeAt(0), 0xfeff, "BOM");
  eq(csv.slice(1), "A;B\r\n1;2\r\n", "lines");
});

Deno.test("export rows: words for yes/no/unknown, roles, statuses, the shop's time", () => {
  const row: ExportRow = {
    conversation_id: "3f2a9c1b-0000-4000-8000-000000000000",
    started_at: "2026-10-30T13:00:00Z",
    status: "new",
    starred: true,
    unanswered: null,
    access_key_used: false,
    language: "hu",
    message_at: "2026-10-30T13:01:00Z",
    role: "shopper",
    body: "Van tej?",
    body_owner: "Máte mlieko?",
    attachments: 0,
    products: null,
  };
  const csv = exportCsv([row], "Europe/Bratislava", {
    header: ["id", "start", "status", "star", "na", "key", "lang", "time", "who", "text", "sk", "files", "products"],
    yes: "áno",
    no: "nie",
    shopper: "Zákazník",
    assistant: "Asistent",
    status: { new: "Nové" },
  });
  eq(
    csv.split("\r\n")[1],
    "3f2a9c1b-0000-4000-8000-000000000000;2026-10-30 14:00;Nové;áno;;nie;hu;2026-10-30 14:01;Zákazník;Van tej?;Máte mlieko?;;",
    "row",
  );
});

Deno.test("TXT: title, facts, messages with files, cards and the no-answer mark", () => {
  const txt = conversationTxt(
    [
      { role: "shopper", body: "Máte Granko?", body_owner: null, created_at: "2026-10-30T13:00:00Z", files: ["foto.jpg"], cards: [] },
      {
        role: "assistant",
        body: "Áno.",
        body_owner: null,
        created_at: "2026-10-30T13:00:05Z",
        unanswered: true,
        files: [],
        cards: [{ name: "Granko", price: "1,99 €", availability: "12 ks na sklade", quantity: 2, note: "na raňajky" }],
      },
    ],
    "Europe/Bratislava",
    {
      title: "Konverzácia – Potraviny",
      facts: [["Začiatok", "2026-10-30 14:00"], ["Poznámka", ""]],
      shopper: "Zákazník",
      assistant: "Asistent",
      inOwnerLang: "Po slovensky:",
      files: "Súbory",
      unanswered: "Asistent nevedel odpovedať",
    },
  );
  eq(
    txt.split("\r\n"),
    [
      "Konverzácia – Potraviny",
      "=======================",
      "Začiatok: 2026-10-30 14:00",
      "",
      "[2026-10-30 14:00] Zákazník:",
      "Máte Granko?",
      "Súbory: foto.jpg",
      "",
      "[2026-10-30 14:00] Asistent:",
      "Áno.",
      "(Asistent nevedel odpovedať)",
      "  • 2× Granko – 1,99 € – 12 ks na sklade (na raňajky)",
      "",
    ],
    "lines (an empty fact is left out)",
  );
});

Deno.test("file names like the PDFs'", () => {
  eq(exportName("2026-10-30T13:05:00Z", "3f2a9c1b-0000-4000-8000-000000000000", "Europe/Bratislava", "txt"), "konverzacia_2026-10-30_14-05_3f2a9c1b.txt", "txt");
});
