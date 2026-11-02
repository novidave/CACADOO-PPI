import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  checkMove,
  cleanTime,
  dotState,
  hoursMinutes,
  margin,
  minutesLeft,
  movementsSheet,
  netPrice,
  parseAmount,
  parsePrice,
  productsSheet,
  ScanBurst,
  signedQty,
  stockValue,
  totalEffect,
} from "./sklad.ts";

Deno.test("amounts: comma or dot, up to 3 decimals, nothing else", () => {
  assertEquals(parseAmount("12"), 12);
  assertEquals(parseAmount("0,5"), 0.5);
  assertEquals(parseAmount(" 1 000 "), 1000);
  assertEquals(parseAmount("-3"), -3);
  assertEquals(parseAmount("1.2345"), null);
  assertEquals(parseAmount("abc"), null);
  assertEquals(parseAmount(""), null);
});

Deno.test("prices: empty = no price, invalid = NaN", () => {
  assertEquals(parsePrice("24,90"), 24.9);
  assertEquals(parsePrice("24,90 €"), 24.9);
  assertEquals(parsePrice(""), null);
  assert(Number.isNaN(parsePrice("-1") as number));
  assert(Number.isNaN(parsePrice("x") as number));
});

Deno.test("the card's forms: positive amounts, a reason for Odpis and Oprava, Presun elsewhere", () => {
  assertEquals(checkMove("receipt", 12, {}), null);
  assertEquals(checkMove("receipt", 0, {}), "qty");
  assertEquals(checkMove("sale", -1, {}), "qty");
  assertEquals(checkMove("writeoff", 1, {}), "reason");
  assertEquals(checkMove("writeoff", 1, { reason: "poškodené" }), null);
  assertEquals(checkMove("correction", -2, { reason: "preklep" }), null);
  assertEquals(checkMove("correction", 0, { reason: "preklep" }), "qty");
  assertEquals(checkMove("transfer", 4, { from: "a", to: "a" }), "to_location");
  assertEquals(checkMove("transfer", 4, { from: "a", to: "b" }), null);
  assertEquals(checkMove("receipt", 1, { cost: Number.NaN }), "unit_cost");
  assertEquals(checkMove("receipt", null, {}), "qty");
});

Deno.test("a transfer keeps the total", () => {
  assertEquals(totalEffect("transfer", 4), 0);
  assertEquals(totalEffect("receipt", 12) + totalEffect("transfer", 4) + totalEffect("sale", -2), 10);
});

Deno.test("prices without VAT, margin from the average cost, stock value", () => {
  assertEquals(netPrice(24.9, 23), 20.24);
  assertEquals(margin(24.9, 23, 15.2), { amount: 5.04, percent: 24.9 });
  assertEquals(margin(null, 23, 15.2), null);
  assertEquals(margin(24.9, 23, null), null);
  assertEquals(stockValue(18, 15.2), 273.6);
  assertEquals(stockValue(-2, 15.2), 0);
  assertEquals(stockValue(5, null), null);
});

Deno.test("signed amounts with a real minus sign; the dot", () => {
  assertEquals(signedQty("receipt", 12, "sk"), "+12");
  assertEquals(signedQty("sale", -2, "sk"), "−2");
  assertEquals(signedQty("transfer", 4, "sk"), "4");
  assertEquals(dotState(3), "in");
  assertEquals(dotState(0), "out");
  assertEquals(dotState(-1), "out");
});

Deno.test("time left until stale", () => {
  const now = new Date("2026-11-02T08:25:00Z");
  assertEquals(minutesLeft("2026-11-02T18:00:00Z", now), 575);
  assertEquals(hoursMinutes(575), "9 h 35 min");
  assertEquals(hoursMinutes(35), "35 min");
  assertEquals(minutesLeft("2026-11-01T08:00:00Z", now), 0);
  assertEquals(minutesLeft(null, now), 0);
  assertEquals(cleanTime("8:00"), "08:00");
  assertEquals(cleanTime("24:00"), null);
  assertEquals(cleanTime("x"), null);
});

Deno.test("a scanner's burst ending in Enter is a code; a person's typing is not", () => {
  const s = new ScanBurst();
  let t = 1000;
  let code: string | null = null;
  for (const ch of "8580000102315") code = s.feed(ch, (t += 8)) ?? code;
  assertEquals(code, null);
  assertEquals(s.feed("Enter", (t += 8)), "8580000102315");
  // slow typing (120 ms between keys) is never a scan
  for (const ch of "8580000102315") s.feed(ch, (t += 120));
  assertEquals(s.feed("Enter", (t += 120)), null);
  // too short
  for (const ch of "12345") s.feed(ch, (t += 5));
  assertEquals(s.feed("Enter", (t += 5)), null);
  // Shift between letters keeps the burst; arrow keys break it
  for (const ch of ["Shift", "A", "B", "Shift", "C", "1", "2", "3"]) s.feed(ch, (t += 5));
  assertEquals(s.feed("Enter", (t += 5)), "ABC123");
  for (const ch of ["1", "2", "3", "ArrowLeft", "4", "5", "6"]) s.feed(ch, (t += 5));
  assertEquals(s.feed("Enter", (t += 5)), null);
});

Deno.test("the exports: a column per location, the kind in words, the shop's time", () => {
  const rows = productsSheet(
    [
      {
        id: "1", name: "Farba", code: "10231", ean: "858", sale_price: 24.9, min_qty: 5, unit: "ks", shelf: "A3", total: 18,
        locations: [{ location_id: "s", name: "Predajňa", qty: 6 }, { location_id: "b", name: "Sklad", qty: 12 }],
        is_out: false, is_low: false, no_price: false,
      },
    ],
    { name: "Názov", code: "Kód", ean: "EAN", unit: "Jednotka", price: "Cena", min: "Minimum", shelf: "Regál", total: "Spolu" },
  );
  assertEquals(rows[0], ["Názov", "Kód", "EAN", "Jednotka", "Cena", "Minimum", "Regál", "Predajňa", "Sklad", "Spolu"]);
  assertEquals(rows[1], ["Farba", "10231", "858", "ks", "24.9", "5", "A3", "6", "12", "18"]);
  const mv = movementsSheet(
    [{ id: "m", item_id: "1", item_name: "Farba", code: "10231", kind: "sale", qty: -2, location: "Predajňa", to_location: null,
       unit_cost: null, reason: null, ref: null, device_label: "telefón", created_at: "2026-11-02T12:52:00Z", client_at: null }],
    { time: "Čas", product: "Produkt", code: "Kód", kind: "Pohyb", qty: "Množstvo", location: "Miesto", to: "Kam", cost: "Nákup", reason: "Dôvod", ref: "Doklad", device: "Zariadenie" },
    { receipt: "Príjem", sale: "Výdaj", writeoff: "Odpis", count: "Inventúra", correction: "Oprava", transfer: "Presun" },
    "Europe/Bratislava",
  );
  assertEquals(mv[1], ["2026-11-02 13:52", "Farba", "10231", "Výdaj", "-2", "Predajňa", "", "", "", "", "telefón"]);
});
