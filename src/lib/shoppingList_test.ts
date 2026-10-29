import { assertEquals } from "jsr:@std/assert@1";
import {
  addOne,
  badgeText,
  type ListEntry,
  listStore,
  listText,
  MAX_QTY,
  parseList,
  pieces,
  pluralForm,
  qtyOf,
  setQty,
  storageKey,
  totals,
} from "./shoppingList.ts";

const paint = { id: "a", name: "Akrylová farba 0,5 l", original: null, price: 9.9, currency: "EUR" };
const brush = { id: "b", name: "Štetec", original: "Ecset", price: 6.4, currency: "EUR" };
const eur = (n: number, c: string) => `${n.toFixed(2).replace(".", ",")} ${c === "EUR" ? "€" : c}`;

Deno.test("add, set and remove pieces", () => {
  let list: ListEntry[] = [];
  list = addOne(list, paint);
  list = addOne(list, paint);
  list = addOne(list, brush);
  assertEquals(list.map((e) => [e.id, e.qty]), [["a", 2], ["b", 1]]);
  assertEquals(pieces(list), 3);
  assertEquals(qtyOf(list, "a"), 2);
  assertEquals(qtyOf(list, "x"), 0);
  list = setQty(list, "a", 1);
  assertEquals(qtyOf(list, "a"), 1);
  list = setQty(list, "a", 0);
  assertEquals(list.map((e) => e.id), ["b"]);
  assertEquals(setQty(list, "b", 5000)[0].qty, MAX_QTY);
});

Deno.test("badge text: 9+ above nine", () => {
  assertEquals(badgeText(1), "1");
  assertEquals(badgeText(9), "9");
  assertEquals(badgeText(10), "9+");
  assertEquals(badgeText(120, 99), "99+");
});

Deno.test("line prices and totals in cents, per currency", () => {
  const list = addOne(addOne(addOne(addOne([], paint), paint), { ...brush, price: 0.1 }), { id: "c", name: "Bez ceny", original: null, price: null, currency: "EUR" });
  assertEquals(totals(list), [{ currency: "EUR", amount: 19.9 }]);
  const mixed = addOne(list, { id: "h", name: "Festék", original: null, price: 1890, currency: "HUF" });
  assertEquals(totals(mixed), [{ currency: "EUR", amount: 19.9 }, { currency: "HUF", amount: 1890 }]);
});

Deno.test("Slovak plurals: 1 produkt, 2–4 produkty, 5+ (and 0) produktov", () => {
  assertEquals([0, 1, 2, 3, 4, 5, 11, 21, 22].map((n) => pluralForm(n, "sk")), ["other", "one", "few", "few", "few", "other", "other", "other", "other"]);
  assertEquals([1, 2, 5].map((n) => pluralForm(n, "en")), ["one", "other", "other"]);
  assertEquals(pluralForm(2, "not a language!"), "other");
});

Deno.test("the copied text: shop name, address, lines, total", () => {
  const list = addOne(addOne(addOne([], paint), paint), brush);
  const text = listText(list, { title: "Nákupný zoznam", shopName: "Davide", address: "Hlavná 1, 040 01 Košice", total: "Spolu", format: eur });
  assertEquals(
    text,
    ["Nákupný zoznam – Davide", "Hlavná 1, 040 01 Košice", "", "2× Akrylová farba 0,5 l – 19,80 €", "1× Štetec (Ecset) – 6,40 €", "", "Spolu: 26,20 €"].join("\n"),
  );
  const noPrice = listText([{ ...paint, price: null, qty: 1 }], { title: "T", shopName: "S", address: null, total: "Spolu", format: eur });
  assertEquals(noPrice, "T – S\n\n1× Akrylová farba 0,5 l");
});

Deno.test("parseList drops broken entries", () => {
  assertEquals(parseList(null), []);
  assertEquals(parseList("not json"), []);
  assertEquals(parseList('{"a":1}'), []);
  const raw = JSON.stringify([
    { ...paint, qty: 2 },
    { ...paint, qty: 3 }, // the same id twice
    { id: "z", name: "", qty: 1 },
    { id: "y", name: "Y", qty: 0 },
    { id: "w", name: "W", qty: 1.7, price: "9", currency: "euro" },
  ]);
  assertEquals(parseList(raw), [
    { ...paint, qty: 2 },
    { id: "w", name: "W", original: null, price: null, currency: "EUR", qty: 1 },
  ]);
});

Deno.test("the store keeps one list per shop in localStorage, and works when storage is blocked", () => {
  localStorage.clear();
  const store = listStore("shop-1");
  let calls = 0;
  const off = store.subscribe(() => calls++);
  store.set(addOne(store.get(), paint));
  assertEquals(JSON.parse(localStorage.getItem(storageKey("shop-1"))!)[0].id, "a");
  assertEquals(listStore("shop-1").get(), store.get(), "the same store for the same shop");
  assertEquals(listStore("shop-2").get(), []);
  store.set([]);
  assertEquals(localStorage.getItem(storageKey("shop-1")), null);
  assertEquals(calls, 2);
  off();

  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
  try {
    const blocked = listStore("shop-blocked");
    assertEquals(blocked.get(), []);
    blocked.set(addOne(blocked.get(), brush));
    assertEquals(blocked.get()[0].id, "b", "kept for this visit");
  } finally {
    Object.defineProperty(globalThis, "localStorage", real);
  }
});
