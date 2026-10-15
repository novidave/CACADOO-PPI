// Tests of the partner-feeds function: every format, parts cut anywhere, encodings, gzip, the size limit, "not
// modified", forwards, and the whole chain of steps against an in-memory stand-in for the database.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  columnKey,
  csvRecords,
  type Deps,
  detectEncoding,
  type Format,
  handle,
  maxBytesFrom,
  parsePrice,
  parseText,
  partPath,
  type ProductRow,
  safeUrl,
  splitIntoParts,
  type StockRow,
  xmlFields,
  xmlRecords,
} from "./index.ts";

// ---------------------------------------------------------------- fixtures

const GOOGLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
<title>Šport Partner</title>
<link>https://partner.example.com</link>
<item>
<g:id>S1</g:id>
<title><![CDATA[Stan Quechua 2 Seconds & <Easy>]]></title>
<link>https://partner.example.com/p/s1?utm=a&amp;b=c</link>
<g:shipping><g:country>SK</g:country><g:price>3.99 EUR</g:price></g:shipping>
<g:image_link>https://cdn.example.com/s1.jpg</g:image_link>
<g:price>89.99 EUR</g:price>
<g:sale_price>79,99 EUR</g:sale_price>
<g:sale_price_effective_date>2026-10-01T00:00+02:00/2026-10-31T23:59+01:00</g:sale_price_effective_date>
<g:availability>in stock</g:availability>
<g:brand>Quechua</g:brand>
<g:gtin>3608439000001</g:gtin>
<g:product_type>Kemping &gt; Stany</g:product_type>
<description>Stan &lt;b&gt;pre 2&lt;/b&gt;</description>
</item>
<item>
<g:id>S2</g:id>
<g:title>Kladivo tesárske 600&#160;g</g:title>
<g:link>http://partner.example.com/p/s2</g:link>
<g:image_link>http://cdn.example.com/s2.jpg</g:image_link>
<g:price>19.99 EUR</g:price>
<g:availability>out_of_stock</g:availability>
<!-- <g:availability>in_stock</g:availability> -->
</item>
<item>
<title>Bez kódu</title>
<g:price>1.00 EUR</g:price>
</item>
<items>not an item</items>
</channel>
</rss>
`;

const GOOGLE_ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:g="http://base.google.com/ns/1.0">
<title>Partner</title>
<entry>
<g:id>A1</g:id>
<title>Batoh 20 l</title>
<link rel="alternate" href="https://partner.example.com/a1?x=1&amp;y=2"/>
<g:price>EUR 24.99</g:price>
<g:availability>preorder</g:availability>
</entry>
</feed>`;

const GOOGLE_TSV = [
  "id\ttitle\tlink\tprice\tavailability\tbrand\timage link\tsale price",
  'T1\t"Fľaša 0,5 l ""Steel"""\thttps://partner.example.com/t1\t12.50 EUR\tin_stock\tKalenji\thttps://cdn.example.com/t1.jpg\t',
  'T2\t"Ponožky\nbežecké"\thttps://partner.example.com/t2\t4,99 EUR\tbackorder\t\t\t3.99 EUR',
  "T3\tPalica\t\t\tout of stock\t\t\t",
  "",
].join("\r\n");

// "Čelovka Žltá" in Windows-1250: Č = 0xC8, Ž = 0x8E, á = 0xE1
function win1250(text: string): Uint8Array {
  const map: Record<string, number> = { "Č": 0xc8, "Ž": 0x8e, "á": 0xe1, "č": 0xe8, "ž": 0x9e };
  return Uint8Array.from([...text].map((c) => map[c] ?? c.charCodeAt(0)));
}
const HEUREKA = `<?xml version="1.0" encoding="windows-1250"?>
<SHOP>
<SHOPITEM><ITEM_ID>H1</ITEM_ID><PRODUCTNAME>Čelovka Žltá</PRODUCTNAME><PRODUCT>Čelovka</PRODUCT><URL>https://bazar.example.org/h1</URL><IMGURL>https://bazar.example.org/h1.jpg</IMGURL><PRICE_VAT>19,90</PRICE_VAT><MANUFACTURER>Petzl</MANUFACTURER><EAN>8590000000001</EAN><CATEGORYTEXT>Šport | Turistika</CATEGORYTEXT><DELIVERY_DATE>0</DELIVERY_DATE></SHOPITEM>
<SHOPITEM><ITEM_ID>H2</ITEM_ID><PRODUCT>Spacák</PRODUCT><PRICE_VAT>59</PRICE_VAT><DELIVERY_DATE>5</DELIVERY_DATE></SHOPITEM>
<SHOPITEM><ITEM_ID>H3</ITEM_ID><PRODUCTNAME>Karimatka</PRODUCTNAME><PRICE_VAT>9.5</PRICE_VAT><DELIVERY_DATE>2026-11-02</DELIVERY_DATE></SHOPITEM>
</SHOP>`.replace("Šport", "Sport");

const PLAIN_CSV = [
  "Kód;Názov;Cena;Množstvo;Odkaz;Značka;Poznámka",
  'C1;Kladivo 500 g;"24,99 €";12;https://shop.example.net/c1;Fiskars;interná',
  'C2;Klince 100 ks;"1 234,50 Ft";0;;;',
  "C3;;5;1;;;",
  "C4;Pílka;3.20;;;;",
].join("\n");

const LOCAL_XML = `<?xml version="1.0"?>
<rss xmlns:g="http://base.google.com/ns/1.0"><channel>
<item><g:store_code>KE1</g:store_code><g:id>S1</g:id><g:availability>limited_availability</g:availability><g:quantity>1</g:quantity></item>
<item><g:store_code>MI1</g:store_code><g:itemid>S1</g:itemid><g:availability>out of stock</g:availability></item>
<item><g:store_code>BA1</g:store_code><g:id>S2</g:id><g:quantity>8</g:quantity></item>
<item><g:id>S9</g:id><g:availability>in_stock</g:availability></item>
</channel></rss>`;

const LOCAL_CSV = "store code,id,availability,quantity\nKE1,S1,in_stock,3\nMI1,S1,on_display_to_order,0\n";

// ---------------------------------------------------------------- pieces

Deno.test("prices: numbers and the currency the text names", () => {
  assertEquals(parsePrice("24.99 EUR"), { amount: 24.99, currency: "EUR" });
  assertEquals(parsePrice("EUR 24,99"), { amount: 24.99, currency: "EUR" });
  assertEquals(parsePrice("1 234,56 €"), { amount: 1234.56, currency: "EUR" });
  assertEquals(parsePrice("1.890 Ft"), { amount: 1890, currency: "HUF" });
  assertEquals(parsePrice("1,234.50 USD"), { amount: 1234.5, currency: "USD" });
  assertEquals(parsePrice("249 Kč"), { amount: 249, currency: "CZK" });
  assertEquals(parsePrice("19,90"), { amount: 19.9, currency: null });
  assertEquals(parsePrice("24,99 € s DPH"), { amount: 24.99, currency: "EUR" }, "DPH is no currency");
  assertEquals(parsePrice("-5 EUR").amount, null);
  assertEquals(parsePrice("zadarmo"), { amount: null, currency: null });
  assertEquals(parsePrice(null), { amount: null, currency: null });
});

Deno.test("column names and safe addresses", () => {
  assertEquals(columnKey("Image link"), "image_link");
  assertEquals(columnKey("g:sale_price"), "sale_price");
  assertEquals(columnKey(" Názov produktu "), "nazov_produktu");
  assert(safeUrl("https://feeds.example.com/a.xml"));
  for (const bad of ["http://feeds.example.com/a.xml", "https://127.0.0.1/a.xml", "https://localhost/a", "https://x.local/a",
    "https://user:pw@example.com/a", "https://[::1]/a", "ftp://example.com/a", "not a url"]) {
    assertEquals(safeUrl(bad), null, bad);
  }
  assertEquals(maxBytesFrom(null), 50 * 1024 * 1024);
  assertEquals(maxBytesFrom("120"), 120 * 1024 * 1024);
  assertEquals(maxBytesFrom("9999"), 500 * 1024 * 1024, "at most 500 MB");
  assertEquals(maxBytesFrom("abc"), 50 * 1024 * 1024);
});

Deno.test("XML: only whole item tags, top-level fields, CDATA, entities, comments", () => {
  const { records, rest } = xmlRecords(GOOGLE_RSS, "item", true);
  assertEquals(records.length, 3, "<items> is no item");
  assertEquals(rest, "");
  const f = xmlFields(records[0]);
  assertEquals(f.get("title"), "Stan Quechua 2 Seconds & <Easy>");
  assertEquals(f.get("link"), "https://partner.example.com/p/s1?utm=a&b=c");
  assertEquals(f.get("price"), "89.99 EUR", "the shipping price inside <g:shipping> is not the price");
  assertEquals(f.get("description"), "Stan <b>pre 2</b>");
  const second = xmlFields(records[1]);
  assertEquals(second.get("availability"), "out_of_stock", "a comment is not a field");
  // an item that goes on in the next part waits; a cut "<ite" waits too
  const cut = xmlRecords("<item><id>1</id></item>\n<item><id>2</id>", "item", false);
  assertEquals(cut.records.length, 1);
  assertEquals(cut.rest, "<item><id>2</id>");
  assertEquals(xmlRecords("<item><id>1</id></item>\n<ite", "item", false).rest, "\n<ite");
});

Deno.test("Google XML (RSS): rows as the feed wrote them", () => {
  const p = parseText("google_xml", GOOGLE_RSS, true, null, null);
  assertEquals([p.read, p.bad], [3, 1], "the item without an id is unreadable");
  const [s1, s2] = p.rows as ProductRow[];
  assertEquals(s1, {
    id: "S1", title: "Stan Quechua 2 Seconds & <Easy>", brand: "Quechua", gtin: "3608439000001", mpn: null,
    category: "Kemping > Stany", price: 89.99, sale_price: 79.99, sale_from: "2026-09-30T22:00:00.000Z",
    sale_to: "2026-10-31T22:59:00.000Z", currency: "EUR", availability: "in stock", state: "in_stock", days: null,
    link: "https://partner.example.com/p/s1?utm=a&b=c", image: "https://cdn.example.com/s1.jpg",
  });
  assertEquals(s2.title, "Kladivo tesárske 600\u00a0g", "kept as written (no-break space too)");
  assertEquals([s2.state, s2.link, s2.image], ["out_of_stock", "http://partner.example.com/p/s2", null], "only https pictures");
  assertEquals(p.header, { tag: "item" });
});

Deno.test("Google XML (Atom): <entry> and <link href>", () => {
  const p = parseText("google_xml", GOOGLE_ATOM, true, null, null);
  const [a1] = p.rows as ProductRow[];
  assertEquals([a1.id, a1.title, a1.link, a1.price, a1.currency, a1.state], ["A1", "Batoh 20 l", "https://partner.example.com/a1?x=1&y=2", 24.99, "EUR", "preorder"]);
  assertEquals(p.header, { tag: "entry" });
});

Deno.test("Google CSV/TSV: quotes, quoted line breaks, names with spaces", () => {
  const p = parseText("google_csv", GOOGLE_TSV, true, null, null);
  assertEquals([p.read, p.bad], [3, 0]);
  const [t1, t2, t3] = p.rows as ProductRow[];
  assertEquals([t1.title, t1.brand, t1.image, t1.price], ['Fľaša 0,5 l "Steel"', "Kalenji", "https://cdn.example.com/t1.jpg", 12.5]);
  assertEquals([t2.title, t2.state, t2.price, t2.sale_price], ["Ponožky\nbežecké".replace("\n", " "), "backorder", 4.99, 3.99]);
  assertEquals([t3.state, t3.price, t3.currency], ["out_of_stock", null, null]);
  assertEquals((p.header as { delimiter: string }).delimiter, "\t");
});

Deno.test("Heureka XML in Windows-1250: the partner's currency, DELIVERY_DATE as written", () => {
  const bytes = win1250(HEUREKA);
  assertEquals(detectEncoding(bytes, true), "windows-1250");
  const text = new TextDecoder("windows-1250").decode(bytes);
  const p = parseText("heureka_xml", text, true, null, "EUR");
  const [h1, h2, h3] = p.rows as ProductRow[];
  assertEquals([h1.title, h1.price, h1.currency, h1.brand, h1.gtin, h1.state, h1.availability], ["Čelovka Žltá", 19.9, "EUR", "Petzl", "8590000000001", "in_stock", "0"]);
  assertEquals([h2.title, h2.state, h2.days], ["Spacák", "in_days", 5], "PRODUCT when there is no PRODUCTNAME");
  assertEquals([h3.state, h3.days, h3.availability], ["unknown", null, "2026-11-02"], "a date stays as the partner wrote it");
});

Deno.test("plain CSV: Slovak column names, quantity, private columns left out", () => {
  const p = parseText("csv", PLAIN_CSV, true, null, "EUR");
  assertEquals([p.read, p.bad], [4, 1], "a row without a name is unreadable");
  const rows = p.rows as ProductRow[];
  assertEquals(rows.map((r) => [r.id, r.state, r.price, r.currency]), [
    ["C1", "in_stock", 24.99, "EUR"],
    ["C2", "out_of_stock", 1234.5, "HUF"],
    ["C4", "unknown", 3.2, "EUR"],
  ]);
  assertEquals(rows[0].brand, "Fiskars");
  assert(!JSON.stringify(rows).includes("interná"), "a column outside the known ones is never stored");
  const wrong = parseText("csv", "a;b;c\n1;2;3\n", true, null, null);
  assertEquals(wrong.error?.code, "columns");
});

Deno.test("local inventory feed: stock per store only from its rows", () => {
  const xml = parseText("google_local_xml", LOCAL_XML, true, null, null);
  assertEquals([xml.read, xml.bad], [4, 1], "a row without a store is unreadable");
  assertEquals(xml.rows as StockRow[], [
    { id: "S1", store: "KE1", availability: "limited_availability", state: "limited", quantity: 1 },
    { id: "S1", store: "MI1", availability: "out of stock", state: "out_of_stock", quantity: null },
    { id: "S2", store: "BA1", availability: null, state: "in_stock", quantity: 8 },
  ]);
  const csv = parseText("google_local_csv", LOCAL_CSV, true, null, null);
  assertEquals((csv.rows as StockRow[]).map((r) => [r.store, r.state, r.quantity]), [["KE1", "in_stock", 3], ["MI1", "on_display", 0]]);
});

/** A feed cut into tiny parts the real way (splitIntoParts) and read part by part with the carry. */
async function readInParts(format: Format, bytes: Uint8Array, partBytes: number, currency: string | null) {
  const parts: Uint8Array[] = [];
  await splitIntoParts(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(), { partBytes, maxBytes: 1e9, put: async (_n, b) => void parts.push(b) });
  // A real part 0 is 4 MB and holds the XML declaration; these tiny test parts may not.
  const encoding = detectEncoding(bytes, format.endsWith("xml"));
  let carry = "";
  let header: Record<string, unknown> | null = null;
  const rows: unknown[] = [];
  let read = 0;
  let bad = 0;
  parts.forEach((part, i) => {
    const p = parseText(format, carry + new TextDecoder(encoding).decode(part), i === parts.length - 1, header, currency);
    assert(!p.error, p.error?.detail);
    rows.push(...p.rows);
    read += p.read;
    bad += p.bad;
    carry = p.rest;
    header = header ?? p.header;
  });
  assertEquals(carry, "");
  return { rows, read, bad, parts: parts.length };
}

Deno.test("parts cut anywhere read the same rows as the whole file", async () => {
  const cases: [Format, Uint8Array, string | null][] = [
    ["google_xml", new TextEncoder().encode(GOOGLE_RSS), null],
    ["google_xml", new TextEncoder().encode(GOOGLE_ATOM), null],
    ["google_csv", new TextEncoder().encode(GOOGLE_TSV), null],
    ["heureka_xml", win1250(HEUREKA), "EUR"],
    ["csv", new TextEncoder().encode(PLAIN_CSV), "EUR"],
    ["google_local_xml", new TextEncoder().encode(LOCAL_XML), null],
    ["google_local_csv", new TextEncoder().encode(LOCAL_CSV), null],
  ];
  for (const [format, bytes, currency] of cases) {
    const encoding = detectEncoding(bytes, format.endsWith("xml"));
    const whole = parseText(format, new TextDecoder(encoding).decode(bytes), true, null, currency);
    for (const size of [7, 13, 31, 64, 257]) {
      const inParts = await readInParts(format, bytes, size, currency);
      assert(inParts.parts > 1 || bytes.length <= size);
      assertEquals(inParts.rows, whole.rows, `${format} in parts of ${size} bytes`);
      assertEquals([inParts.read, inParts.bad], [whole.read, whole.bad], `${format} counts in parts of ${size}`);
    }
  }
});

Deno.test("parts end at a line break and never cut a character", async () => {
  const text = "Žltá čelovka\n".repeat(50);
  const parts: Uint8Array[] = [];
  const done = await splitIntoParts(new Blob([new TextEncoder().encode(text)]).stream(), { partBytes: 100, maxBytes: 1e6, put: async (_n, b) => void parts.push(b) });
  assertEquals(done.parts, parts.length);
  for (const part of parts.slice(0, -1)) assertEquals(part[part.length - 1], 0x0a);
  assertEquals(parts.map((p) => new TextDecoder("utf-8", { fatal: true }).decode(p)).join(""), text);
  const records = csvRecords('a,"b\nc"\nd,e', ",", true).records;
  assertEquals(records, [["a", "b\nc"], ["d", "e"]]);
});

Deno.test("encodings: BOM, the XML declaration, valid UTF-8, else Windows-1250", () => {
  assertEquals(detectEncoding(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]), false), "utf-8");
  assertEquals(detectEncoding(new TextEncoder().encode('<?xml version="1.0" encoding="ISO-8859-2"?><a/>'), true), "iso-8859-2");
  assertEquals(detectEncoding(new TextEncoder().encode("Názov;Cena\n"), false), "utf-8");
  assertEquals(detectEncoding(win1250("Názov;Cena\nČelovka;1\n"), false), "windows-1250");
  assertEquals(detectEncoding(Uint8Array.from([0xff, 0xfe, 0x61, 0x00]), false), "utf-16");
});

Deno.test("a wrong format stops with a clear reason", () => {
  const notXml = parseText("google_xml", "id,title\n1,a\n", true, null, null);
  assertEquals(notXml.error?.code, "format");
  const noItems = parseText("heureka_xml", "<rss>" + " ".repeat(3 * 1024 * 1024) + "<item/></rss>", false, null, null);
  assertEquals(noItems.error?.code, "format");
  const waits = parseText("google_xml", "<?xml version='1.0'?><rss><channel><ti", false, null, null);
  assert(!waits.error && waits.rest.length > 0, "a short start waits for the next part");
});

// ---------------------------------------------------------------- the chain of steps (an in-memory database)

interface Imp {
  id: string; partner_id: string; kind: "products" | "inventory"; source: "url" | "file"; source_key: string; force: boolean;
  status: string; error: string | null; error_detail: string | null; feed_time: string | null; source_modified: string | null;
  etag: string | null; bytes: number; parts: number; part_index: number; carry: string; encoding: string | null;
  header: unknown; rows_read: number; rows_bad: number; locked: boolean; attempts: number; started: number;
}
interface Partner {
  id: string; feed_url: string | null; feed_file_path: string | null; feed_file_at: string | null; feed_format: Format;
  inventory_url: string | null; inventory_format: Format | null; currency: string | null; due: boolean; force_next: boolean;
}

class FakeDb {
  partners = new Map<string, Partner>();
  imports = new Map<string, Imp>();
  products = new Map<string, Record<string, unknown> & { import_id: string; updated_at: string }>();
  stock = new Map<string, Record<string, unknown> & { import_id: string }>();
  calls: string[] = [];
  n = 0;

  partner(p: Partial<Partner> & { id: string }) {
    this.partners.set(p.id, {
      feed_url: null, feed_file_path: null, feed_file_at: null, feed_format: "google_xml", inventory_url: null,
      inventory_format: null, currency: null, due: true, force_next: false, ...p,
    });
  }

  rpc = async (name: string, args: Record<string, unknown> = {}) => {
    this.calls.push(name);
    const ok = (data: unknown) => ({ data, error: null });
    const imp = this.imports.get(String(args.p_import ?? ""));
    switch (name) {
      case "assistant_cron_ok":
        return ok(args.p_secret === "cron-secret-0123456789abcdefghijklmnop");
      case "partner_start_due": {
        const ids: string[] = [];
        for (const p of this.partners.values()) {
          if (!p.due) continue;
          for (const kind of ["products", "inventory"] as const) {
            const url = kind === "products" ? p.feed_url : p.inventory_url;
            const file = kind === "products" ? p.feed_file_path : null;
            const format = kind === "products" ? p.feed_format : p.inventory_format;
            if (!url && !file) continue;
            if ([...this.imports.values()].some((i) => i.partner_id === p.id && i.kind === kind && ["download", "parse"].includes(i.status))) continue;
            const id = `00000000-0000-0000-0000-${String(++this.n).padStart(12, "0")}`;
            this.imports.set(id, {
              id, partner_id: p.id, kind, source: url ? "url" : "file", source_key: `${url ?? file}|${format}`, force: p.force_next,
              status: "download", error: null, error_detail: null, feed_time: null, source_modified: null, etag: null, bytes: 0,
              parts: 0, part_index: 0, carry: "", encoding: null, header: null, rows_read: 0, rows_bad: 0, locked: false,
              attempts: 0, started: this.n,
            });
            ids.push(id);
          }
          p.due = false;
          p.force_next = false;
        }
        return ok(ids);
      }
      case "partner_imports_waiting":
        return ok([...this.imports.values()].filter((i) => ["download", "parse"].includes(i.status) && !i.locked).map((i) => i.id));
      case "partner_import_claim": {
        if (!imp || !["download", "parse"].includes(imp.status) || imp.locked) return ok(null);
        imp.locked = true;
        imp.attempts++;
        const p = this.partners.get(imp.partner_id)!;
        const prev = imp.force ? null : [...this.imports.values()]
          .filter((i) => i.id !== imp.id && i.partner_id === imp.partner_id && i.kind === imp.kind && i.source_key === imp.source_key && ["done", "unchanged"].includes(i.status))
          .sort((a, b) => b.started - a.started)[0];
        return ok({
          id: imp.id, partner_id: imp.partner_id, kind: imp.kind, source: imp.source, status: imp.status,
          url: imp.kind === "products" ? p.feed_url : p.inventory_url, file_path: imp.kind === "products" ? p.feed_file_path : null,
          file_at: p.feed_file_at, format: imp.kind === "products" ? p.feed_format : p.inventory_format, currency: p.currency,
          parts: imp.parts, part_index: imp.part_index, carry: imp.carry, encoding: imp.encoding, header: imp.header,
          previous: prev ? { modified: prev.source_modified, etag: prev.etag, feed_time: prev.feed_time } : null,
        });
      }
      case "partner_import_release":
        if (imp) imp.locked = false;
        return ok(null);
      case "partner_import_downloaded":
        assert(imp && imp.status === "download");
        Object.assign(imp, { status: "parse", parts: args.p_parts, bytes: args.p_bytes, feed_time: args.p_feed_time ?? new Date().toISOString(),
          source_modified: args.p_modified, etag: args.p_etag, locked: false, attempts: 0 });
        return ok(null);
      case "partner_import_unchanged": {
        assert(imp && imp.status === "download");
        Object.assign(imp, { status: "unchanged", locked: false });
        return ok(null);
      }
      case "partner_import_rows": {
        if (!imp || imp.status !== "parse" || imp.part_index !== args.p_part) return { data: null, error: { message: "not at this part" } };
        for (const r of args.p_rows as Record<string, unknown>[]) {
          if (imp.kind === "products") this.products.set(`${imp.partner_id}/${r.id}`, { ...r, import_id: imp.id, updated_at: imp.feed_time! });
          else this.stock.set(`${imp.partner_id}/${r.id}/${r.store}`, { ...r, import_id: imp.id });
        }
        if (args.p_last) {
          imp.part_index++;
          imp.carry = String(args.p_carry ?? "");
          imp.rows_read += Number(args.p_read);
          imp.rows_bad += Number(args.p_bad);
          imp.header = imp.header ?? args.p_header;
          imp.encoding = imp.encoding ?? (args.p_encoding as string);
          imp.locked = false;
          imp.attempts = 0;
        }
        return ok((args.p_rows as unknown[]).length);
      }
      case "partner_import_finish": {
        assert(imp && imp.status === "parse" && imp.part_index >= imp.parts);
        if (imp.rows_read === 0 || imp.rows_bad * 2 > imp.rows_read) {
          Object.assign(imp, { status: "error", error: imp.rows_read === 0 ? "empty" : "unreadable", locked: false });
          return ok({ status: "error" });
        }
        const table = imp.kind === "products" ? this.products : this.stock;
        for (const [k, v] of table) if (k.startsWith(`${imp.partner_id}/`) && v.import_id !== imp.id) table.delete(k);
        Object.assign(imp, { status: "done", locked: false });
        return ok({ status: "done" });
      }
      case "partner_import_fail":
        if (imp && ["download", "parse"].includes(imp.status)) Object.assign(imp, { status: "error", error: args.p_error, error_detail: args.p_detail, locked: false });
        return ok(null);
    }
    return { data: null, error: { message: `unknown rpc ${name}` } };
  };
}

class FakeStore {
  files = new Map<string, Uint8Array>();
  put = async (path: string, bytes: Uint8Array) => void this.files.set(path, bytes.slice());
  get = async (path: string) => this.files.get(path) ?? null;
  stream = async (path: string) => (this.files.has(path) ? new Blob([this.files.get(path)! as Uint8Array<ArrayBuffer>]).stream() : null);
  remove = async (paths: string[]) => void paths.forEach((p) => this.files.delete(p));
  parts = () => [...this.files.keys()].filter((k) => k.startsWith("imports/"));
}

const SERVICE_KEY = "service-key-0123456789abcdefghijklmnopqrstuvwxyz";

function setup(feeds: Record<string, () => Response>, opts: { maxBytes?: number; partBytes?: number } = {}) {
  const db = new FakeDb();
  const store = new FakeStore();
  const queue: string[] = [];
  const background: Promise<unknown>[] = [];
  const requests: { url: string; headers: Headers }[] = [];
  const deps: Deps = {
    rpc: db.rpc,
    isAdmin: async (authorization) => authorization === "Bearer admin-jwt",
    store,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      const make = feeds[url];
      return make ? make() : new Response("not found", { status: 404 });
    }) as typeof fetch,
    chain: async (id) => void queue.push(id),
    background: (task) => void background.push(task),
    serviceKey: SERVICE_KEY,
    maxBytes: opts.maxBytes ?? 10 * 1024 * 1024,
    partBytes: opts.partBytes ?? 256,
    now: () => Date.now(),
  };
  const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    handle(new Request("http://localhost/partner-feeds", { method: "POST", body: JSON.stringify(body), headers }), deps);
  /** The job's tick, then every step it chains, until nothing is left. */
  const runAll = async () => {
    const tick = await post({ action: "tick" }, { "x-ppi-cron": "cron-secret-0123456789abcdefghijklmnop" });
    assertEquals(tick.status, 200);
    for (let guard = 0; queue.length && guard < 500; guard++) {
      const id = queue.shift()!;
      const res = await post({ action: "work", import_id: id }, { Authorization: `Bearer ${SERVICE_KEY}` });
      assertEquals(res.status, 202);
      await Promise.all(background.splice(0));
    }
    assertEquals(queue.length, 0);
  };
  return { db, store, deps, post, runAll, requests };
}

const P1 = "11111111-1111-1111-1111-111111111111";
const FEED = "https://feeds.partner-example.com/google.xml";
const LOCAL = "https://feeds.partner-example.com/local.csv";

Deno.test("a whole import: many parts, each step chaining the next, then the parts are gone", async () => {
  const modified = "Tue, 13 Oct 2026 06:00:00 GMT";
  const t = setup({
    [FEED]: () => new Response(GOOGLE_RSS, { headers: { "last-modified": modified, etag: '"v1"' } }),
    [LOCAL]: () => new Response(LOCAL_CSV),
  });
  t.db.partner({ id: P1, feed_url: FEED, inventory_url: LOCAL, inventory_format: "google_local_csv" });
  await t.runAll();
  const imports = [...t.db.imports.values()];
  assertEquals(imports.map((i) => [i.kind, i.status]), [["products", "done"], ["inventory", "done"]]);
  assert(imports[0].parts > 3, `read in ${imports[0].parts} parts`);
  assertEquals(imports[0].feed_time, new Date(modified).toISOString(), "the data's time is when the partner made the feed");
  assertEquals([...t.db.products.keys()].sort(), [`${P1}/S1`, `${P1}/S2`]);
  assertEquals([...t.db.stock.keys()].sort(), [`${P1}/S1/KE1`, `${P1}/S1/MI1`]);
  assertEquals(t.store.parts(), [], "no part is left in storage");
  assertEquals(t.requests[0].headers.get("if-modified-since"), null, "nothing to compare with the first time");

  // the next turn: If-Modified-Since / If-None-Match; "not modified" changes nothing
  t.db.partners.get(P1)!.due = true;
  const before = JSON.stringify([...t.db.products.entries()]);
  const notModified = setupFeed(t, FEED, () => new Response(null, { status: 304 }));
  await t.runAll();
  assert(notModified.called);
  const last = t.requests.find((r) => r.url === FEED && r.headers.get("if-modified-since"));
  assertEquals(last?.headers.get("if-modified-since"), modified);
  assertEquals(last?.headers.get("if-none-match"), '"v1"');
  assertEquals([...t.db.imports.values()].filter((i) => i.kind === "products").map((i) => i.status), ["done", "unchanged"]);
  assertEquals(JSON.stringify([...t.db.products.entries()]), before);
});

function setupFeed(t: ReturnType<typeof setup>, url: string, make: () => Response) {
  const state = { called: false };
  const original = t.deps.fetch;
  t.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === url) {
      state.called = true;
      t.requests.push({ url, headers: new Headers(init?.headers) });
      return make();
    }
    return original(input, init);
  }) as typeof fetch;
  return state;
}

Deno.test("a feed over PARTNER_FEED_MAX_MB stops with a clear reason: nothing imported, nothing cut, no parts left", async () => {
  const big = GOOGLE_RSS.replace("</channel>", "<!--" + "x".repeat(5000) + "--></channel>");
  const t = setup({ [FEED]: () => new Response(new Blob([big]).stream()) }, { maxBytes: 2000, partBytes: 300 });
  t.db.partner({ id: P1, feed_url: FEED });
  t.db.products.set(`${P1}/OLD`, { id: "OLD", import_id: "earlier", updated_at: "2026-10-01T00:00:00Z" });
  await t.runAll();
  const [imp] = [...t.db.imports.values()];
  assertEquals(imp.status, "error");
  assertEquals(imp.error, "too_big");
  assert(imp.error_detail!.includes("PARTNER_FEED_MAX_MB") && imp.error_detail!.includes("Nothing was imported or cut"), imp.error_detail!);
  assertEquals([...t.db.products.keys()], [`${P1}/OLD`], "the earlier data stays, nothing new");
  assertEquals(t.store.parts(), [], "the parts already copied are removed");
  assert(!t.db.calls.includes("partner_import_rows"), "not one row was written");
});

Deno.test("a Content-Length over the limit stops before the body is read", async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(100)); } });
  const t = setup({ [FEED]: () => new Response(body, { headers: { "content-length": String(60 * 1024 * 1024) } }) }, { maxBytes: 50 * 1024 * 1024 });
  t.db.partner({ id: P1, feed_url: FEED });
  await t.runAll();
  const [imp] = [...t.db.imports.values()];
  assertEquals([imp.status, imp.error], ["error", "too_big"]);
  assert(imp.error_detail!.includes("60 MB"), imp.error_detail!);
  assert(pulled <= 1, "the body was not downloaded");
});

Deno.test("gzip is unpacked on the way; ZIP, HTTP errors and forwards to http are refused with a reason", async () => {
  const gz = new Uint8Array(await new Response(new Blob([GOOGLE_RSS]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  const t = setup({ [FEED]: () => new Response(gz, { headers: { "content-type": "application/gzip" } }) });
  t.db.partner({ id: P1, feed_url: FEED });
  await t.runAll();
  assertEquals([...t.db.imports.values()][0].status, "done");
  assertEquals(t.db.products.size, 2);

  const cases: [string, () => Response][] = [
    ["zip", () => new Response(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))],
    ["http", () => new Response("gone", { status: 410 })],
    ["redirect", () => new Response(null, { status: 302, headers: { location: "http://feeds.partner-example.com/plain.xml" } })],
    ["redirect", () => new Response(null, { status: 301, headers: { location: "https://10.0.0.1/feed.xml" } })],
  ];
  for (const [code, make] of cases) {
    const u = setup({ [FEED]: make });
    u.db.partner({ id: P1, feed_url: FEED });
    await u.runAll();
    const [imp] = [...u.db.imports.values()];
    assertEquals([imp.status, imp.error], ["error", code]);
    assertEquals(u.store.parts(), []);
  }
  // a forward to another public https address is followed
  const moved = "https://cdn.partner-example.com/feed.xml";
  const v = setup({ [FEED]: () => new Response(null, { status: 301, headers: { location: moved } }), [moved]: () => new Response(GOOGLE_ATOM) });
  v.db.partner({ id: P1, feed_url: FEED });
  await v.runAll();
  assertEquals([...v.db.products.keys()], [`${P1}/A1`]);
});

Deno.test("an uploaded file: read as a stream from storage; the same file is not read twice", async () => {
  const t = setup({});
  const path = `${P1}/feed-1760000000000.csv`;
  t.store.files.set(path, new TextEncoder().encode(PLAIN_CSV));
  t.db.partner({ id: P1, feed_file_path: path, feed_file_at: "2026-10-14T08:00:00.000Z", feed_format: "csv", currency: "EUR" });
  await t.runAll();
  const [first] = [...t.db.imports.values()];
  assertEquals([first.status, first.feed_time], ["done", "2026-10-14T08:00:00.000Z"], "the data is from the upload");
  assertEquals(t.db.products.size, 3);
  assertEquals(t.store.parts(), []);
  assert(t.store.files.has(path), "the admin's file stays");
  t.db.partners.get(P1)!.due = true;
  await t.runAll();
  assertEquals([...t.db.imports.values()].map((i) => i.status), ["done", "unchanged"]);
  // "Importovať teraz" reads it again in full
  t.db.partners.get(P1)!.due = true;
  t.db.partners.get(P1)!.force_next = true;
  await t.runAll();
  assertEquals([...t.db.imports.values()].map((i) => i.status), ["done", "unchanged", "done"]);
});

Deno.test("only its callers: the job's secret, the service key, the admin", async () => {
  const t = setup({});
  assertEquals((await t.post({ action: "tick" }, { "x-ppi-cron": "wrong" })).status, 401);
  assertEquals((await t.post({ action: "work", import_id: P1 })).status, 401);
  assertEquals((await t.post({ action: "work", import_id: P1 }, { Authorization: "Bearer not-the-key" })).status, 401);
  assertEquals((await t.post({ action: "run" })).status, 403);
  assertEquals((await t.post({ action: "admin_status" }, { Authorization: "Bearer owner-jwt" })).status, 403);
  const status = await t.post({ action: "admin_status" }, { Authorization: "Bearer admin-jwt" });
  assertEquals(await status.json(), { env: { max_mb: 10, ceiling_mb: 500, part_mb: 0 } });
  assertEquals((await t.post({ action: "run" }, { Authorization: "Bearer admin-jwt" })).status, 200);
  assertEquals((await handle(new Request("http://localhost/x", { method: "GET" }), t.deps)).status, 405);
});

Deno.test("a part that is missing or a broken step never loses data", async () => {
  const t = setup({ [FEED]: () => new Response(GOOGLE_RSS) });
  t.db.partner({ id: P1, feed_url: FEED });
  // the database refuses the first rows once: the step lets go and the next tick goes on from the same part
  let refused = false;
  const rpc = t.db.rpc;
  t.deps.rpc = async (name, args) => {
    if (name === "partner_import_rows" && !refused) {
      refused = true;
      return { data: null, error: { message: "temporary" } };
    }
    return rpc(name, args);
  };
  await t.runAll();
  const [imp] = [...t.db.imports.values()];
  assertEquals(imp.status, "parse", "waits for the next tick");
  await t.runAll();
  assertEquals(imp.status, "done");
  assertEquals(t.db.products.size, 2);
  // a part gone from storage: a clear reason, no half data from it
  const u = setup({ [FEED]: () => new Response(GOOGLE_RSS) });
  u.db.partner({ id: P1, feed_url: FEED });
  const put = u.store.put;
  u.store.put = async (path, bytes) => {
    if (!path.endsWith("00002.part")) await put(path, bytes);
  };
  await u.runAll();
  assertEquals([...u.db.imports.values()][0].error, "parts_missing");
  assertEquals(u.store.parts(), []);
  assertEquals(partPath("x", 3), "imports/x/00003.part");
});
