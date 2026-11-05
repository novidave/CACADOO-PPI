// Unit tests of product photos (database update 78): the bulk files (CSV, XML in the stock importer's formats, the
// sample files), the image_url rule, the report CSV, the assistant's photo (only through show_product_photo, each
// item once, never from the normal tools) — and that no public list, search, feed, the API or the MCP server reads a
// product photo: only the product page and the assistant's photo tool do.
// Run: npm run test:photos
import { photoCard, PHOTO_RULE, PHOTO_TOOL, PHOTO_TOOL_NAME, shownPhotos, type ChatProductPhoto } from "./chatPhoto.ts";
import { columnKey, findColumns, photoUrlOk, productPhotoUrl, readPhotoCsv, readPhotoFile, readPhotoXml, reportCsv, statusCounts, type PhotoFile, PHOTO_ROW_STATUSES } from "./productPhotos.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

function assert(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
}

const file = (read: PhotoFile | string): PhotoFile => {
  if (typeof read === "string") throw new Error(`a problem: ${read}`);
  return read;
};

Deno.test("CSV: code, EAN and image_url by their names (any order, ; or , , quotes, BOM); problems named", () => {
  const f = file(readPhotoCsv('﻿Kód;EAN;Obrázok\r\nA-1;858;"https://x.sk/a.jpg"\r\n;859;https://x.sk/b.jpg\r\n\r\n'));
  eq(f.kind, "csv", "kind");
  eq(f.columns, { code: "Kód", ean: "EAN", url: "Obrázok" }, "columns");
  eq(f.rows, [{ code: "A-1", ean: "858", url: "https://x.sk/a.jpg" }, { code: null, ean: "859", url: "https://x.sk/b.jpg" }], "rows");
  const g = file(readPhotoCsv("image_url,sku\nhttps://x.sk/c.png,Z9\nhttps://x.sk/d.png,Z10\n"));
  eq([g.columns.code, g.columns.url, g.rows[1].code], ["sku", "image_url", "Z10"], "comma, other order, sku");
  // an empty image_url stays a row (the database: "nothing changes")
  eq(file(readPhotoCsv("code;image_url\nA;\n")).rows, [{ code: "A", ean: null, url: null }], "empty address kept");
  eq(readPhotoCsv("code;ean\nA;1\n"), "no_url", "no image column");
  eq(readPhotoCsv("name;image_url\nX;https://x.sk/a.jpg\n"), "no_key", "no code or EAN");
  eq(readPhotoCsv("code;image_url\n"), "empty", "only the header");
});

Deno.test("XML: the sample file, attributes and elements alike, Heureka, Google Merchant, Shoptet", async () => {
  const sample = file(readPhotoXml(await Deno.readTextFile(new URL("../../public/samples/fotky-produktov.xml", import.meta.url))));
  eq(sample.rows, [
    { code: "A-1001", ean: "8584004040123", url: "https://www.vas-obchod.sk/obrazky/a-1001.jpg" },
    { code: "A-1002", ean: null, url: "https://www.vas-obchod.sk/obrazky/a-1002.png" },
    { code: null, ean: "8584004040130", url: "https://www.vas-obchod.sk/obrazky/kriedy-24.webp" },
  ], "the sample XML: its comment is no product, attributes count");
  const csv = file(readPhotoCsv(await Deno.readTextFile(new URL("../../public/samples/fotky-produktov.csv", import.meta.url))));
  eq(csv.rows.length, 3, "the sample CSV");
  const heureka = file(readPhotoXml(`<?xml version="1.0"?><SHOP><SHOPITEM><ITEM_ID>H1</ITEM_ID><PRODUCTNAME>Farba</PRODUCTNAME><URL>https://x.sk/farba</URL><IMGURL>https://x.sk/farba.jpg</IMGURL><IMGURL_ALTERNATIVE>https://x.sk/2.jpg</IMGURL_ALTERNATIVE><EAN>111</EAN></SHOPITEM><SHOPITEM><ITEM_ID>H2</ITEM_ID><IMGURL>https://x.sk/h2.jpg</IMGURL></SHOPITEM></SHOP>`));
  eq(heureka.rows[0], { code: "H1", ean: "111", url: "https://x.sk/farba.jpg" }, "Heureka: IMGURL, never the product's URL");
  const google = file(readPhotoXml(`<rss xmlns:g="http://base.google.com/ns/1.0"><channel><title>Shop</title><item><g:id>G1</g:id><g:gtin>222</g:gtin><g:image_link>https://x.sk/g1.webp</g:image_link><link>https://x.sk/p/g1</link></item><item><g:id>G2</g:id><g:image_link><![CDATA[https://x.sk/g2.webp?a=1&b=2]]></g:image_link></item></channel></rss>`));
  eq(google.rows, [{ code: "G1", ean: "222", url: "https://x.sk/g1.webp" }, { code: "G2", ean: null, url: "https://x.sk/g2.webp?a=1&b=2" }], "Google: g:image_link, CDATA");
  const shoptet = file(readPhotoXml(`<SHOP><SHOPITEM id="1"><CODE>S1</CODE><IMAGES><IMAGE>https://x.sk/s1.jpg</IMAGE><IMAGE>https://x.sk/s1b.jpg</IMAGE></IMAGES></SHOPITEM><SHOPITEM id="2"><CODE>S2</CODE><IMAGES><IMAGE>https://x.sk/s2.jpg</IMAGE></IMAGES></SHOPITEM></SHOP>`));
  eq(shoptet.rows.map((r) => [r.code, r.url]), [["S1", "https://x.sk/s1.jpg"], ["S2", "https://x.sk/s2.jpg"]], "Shoptet: the first IMAGE");
  const nested = file(readPhotoXml(`<items><item><kod>N1</kod><foto url="https://x.sk/n1.jpg"/></item><item><kod>N2</kod><foto url="https://x.sk/n2.jpg"/></item></items>`));
  eq(nested.rows[1], { code: "N2", ean: null, url: "https://x.sk/n2.jpg" }, "<foto url=…>");
  eq(file(readPhotoXml(`<p><product code="X&amp;1" image_url="https://x.sk/a.jpg?x=1&amp;y=2"/></p>`)).rows[0], { code: "X&1", ean: null, url: "https://x.sk/a.jpg?x=1&y=2" }, "one product, entities");
  eq(readPhotoXml("just text"), "not_xml", "not XML");
  eq(readPhotoFile("code;image_url\nA;https://x.sk/a.jpg").kind, "csv", "CSV by its content");
  eq((readPhotoFile("  <p><product code='A' image_url='https://x.sk/a.jpg'/></p>") as PhotoFile).kind, "xml", "XML by its content");
});

Deno.test("Column names: accents, namespaces, attributes; a lone url is never the picture", () => {
  eq(columnKey("Kód produktu"), "kodproduktu", "accents and spaces");
  eq(columnKey("g:image_link"), "imagelink", "namespace");
  eq(columnKey("item/@image_url"), "imageurl", "attribute");
  eq(columnKey("image/@url"), "imageurl", "an image's url");
  eq(columnKey("URL"), "url", "a product page");
  eq(findColumns(["URL", "IMGURL", "ITEM_ID"]).url?.name, "IMGURL", "IMGURL over URL");
  eq(findColumns(["URL", "ITEM_ID"]).url, null, "no picture column");
});

Deno.test("image_url: https only (the database and the function check again)", () => {
  assert(photoUrlOk("https://x.sk/a.jpg"), "https");
  for (const bad of [null, "", "http://x.sk/a.jpg", "https:// x.sk/a.jpg", "ftp://x.sk/a", "javascript:alert(1)", `https://x.sk/${"a".repeat(2000)}`]) {
    assert(!photoUrlOk(bad), `refused: ${String(bad).slice(0, 30)}`);
  }
  eq(productPhotoUrl("https://p.supabase.co/", "s/i/f-800.webp"), "https://p.supabase.co/storage/v1/object/public/product-photos/s/i/f-800.webp", "address");
});

Deno.test("The report: BOM, ; and CRLF, a formula written as text, every status named, counts", () => {
  const status = Object.fromEntries(PHOTO_ROW_STATUSES.map((s) => [s, s.toUpperCase()])) as Record<(typeof PHOTO_ROW_STATUSES)[number], string>;
  const csv = reportCsv(
    [
      { n: 1, code: "A;1", ean: null, url: "https://x.sk/a.jpg", status: "done", detail: null },
      { n: 2, code: "=HYPERLINK(1)", ean: "2", url: null, status: "empty", detail: null },
    ],
    { header: ["Riadok", "Kód", "EAN", "Adresa", "Výsledok", "Dôvod"], status },
  );
  assert(csv.startsWith("﻿Riadok;Kód;EAN;Adresa;Výsledok;Dôvod\r\n"), "BOM + header");
  assert(csv.includes('1;"A;1";;https://x.sk/a.jpg;DONE;\r\n'), `a quoted ; : ${csv}`);
  assert(csv.includes("2;'=HYPERLINK(1);2;;EMPTY;\r\n"), "a formula as text");
  eq(statusCounts([{ status: "done" }, { status: "not_found" }, { status: "done" }]), [{ status: "done", n: 2 }, { status: "not_found", n: 1 }], "counts in order");
});

Deno.test("The assistant shows a photo only when asked (show_product_photo), each item once, never from other tools", async () => {
  const url = (p: string) => `https://p.supabase.co/storage/v1/object/public/product-photos/${p}`;
  const card = photoCard({ name: "Farba biela", href: "/sk/items/1" }, { small: "s/1/a-800.webp", large: "s/1/a-1600.webp", width: 1600, height: 1200 }, url);
  eq(card, { name: "Farba biela", href: "/sk/items/1", src: url("s/1/a-800.webp"), width: 800, height: 600 }, "the 800 px picture, its shown size");
  const none = photoCard({ name: "Štetec", href: "/sk/items/2" }, null, url);
  eq([none.src, none.href], [null, "/sk/items/2"], "no photo: the product link still");
  const cards = new Map<string, ChatProductPhoto>([["r1", card], ["r2", none]]);
  // a normal answer: no show_product_photo call → no photo at all
  eq(shownPhotos([], cards), [], "not asked: nothing");
  eq(shownPhotos(["r1", "r1", "r9", "r2"], cards).map((p) => p.href), ["/sk/items/1", "/sk/items/2"], "asked: each once, unknown refs dropped");
  eq(shownPhotos(["a", "b", "c", "d"], new Map(["a", "b", "c", "d"].map((r, i) => [r, { ...card, href: `/x/${i}` }]))).length, 3, "at most 3");
  assert(PHOTO_TOOL.name === PHOTO_TOOL_NAME && /ONLY when the shopper explicitly asks/.test(PHOTO_TOOL.description), "the tool's own rule");
  assert(/never show or mention pictures on your own/.test(PHOTO_RULE), "the system prompt's rule");
  // the normal tools' data (search_items / get_item) carry no picture: the AI cannot show one on its own
  const chat = await Deno.readTextFile(new URL("./shopChat.ts", import.meta.url));
  const brief = /const brief = \(item: FoundItem\) => \(\{([\s\S]*?)\}\);/.exec(chat)?.[1] ?? "";
  assert(brief.includes("availability") && !/photo|image|picture/i.test(brief), `search_items' rows without a picture: ${brief}`);
  assert(chat.includes("PHOTO_TOOL as Anthropic.Tool") && chat.includes("result.reply.productPhotos = shownPhotos(photoAsked, photoCards)"), "the photos only from the tool's calls");
  eq(chat.match(/"item_photo"/g)?.length, 1, "item_photo is called once: inside the photo tool");
  const tool = chat.indexOf("if (call.name === PHOTO_TOOL_NAME)");
  assert(tool > 0 && chat.indexOf('"item_photo"') > tool && chat.indexOf('"item_photo"') < chat.indexOf("return fail(`Unknown tool", tool), "…inside show_product_photo's own branch");
});

/** Every .ts / .tsx file under a folder. */
async function filesUnder(dir: URL, out: URL[] = []): Promise<URL[]> {
  for await (const e of Deno.readDir(dir)) {
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) await filesUnder(u, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/_test\.ts$/.test(e.name)) out.push(u);
  }
  return out;
}

Deno.test("Only the product page, the assistant's photo tool and a restaurant's Menu read a product photo: no list, search, feed, API or MCP", async () => {
  const src = new URL("../", import.meta.url);
  const rel = (u: URL) => u.pathname.slice(src.pathname.length);
  const readers: string[] = [];
  const addresses: string[] = [];
  for (const u of await filesUnder(src)) {
    const text = await Deno.readTextFile(u);
    if (/["']item_photo["']|getItemPhoto\(/.test(text)) readers.push(rel(u));
    if (/productPhotoUrl\(|PHOTO_BUCKET|product-photos/.test(text)) addresses.push(rel(u));
  }
  // the public read: the product page's data (getItemPhoto in data.ts, used by ItemView) and the assistant's photo tool
  // (supabase/public.ts only lists it among the cached reads)
  eq(readers.sort(), ["app/[lang]/items/[id]/ItemView.tsx", "lib/data.ts", "lib/shopChat.ts", "lib/supabase/public.ts"], "who reads item_photo");
  // the photo's address: the product page, the assistant's card, the owner's screens and the shared rules only — and a
  // restaurant's Menu (update 80, the owner's OK of 2026-11-05: a dish's photo on its Menu; shop_menu() reads it in SQL)
  const allowed = new Set([
    "lib/menu.ts",
    "app/[lang]/items/[id]/ItemView.tsx",
    "lib/data.ts",
    "lib/shopChat.ts",
    "lib/chatPhoto.ts",
    "lib/productPhotos.ts",
    "lib/ownerPhotos.ts",
    "components/owner/ProductPhotoField.tsx",
    "components/owner/PhotoBulkUpload.tsx",
    "app/[lang]/(account)/dashboard/items/photos/page.tsx",
    "app/[lang]/(account)/dashboard/items/photoActions.ts",
    "app/api/owner/product-photos/report/route.ts",
  ]);
  for (const f of addresses) assert(allowed.has(f), `a product photo's address in ${f}`);
  // and certainly not in these: the API, the MCP server, the sitemap, llms.txt, feeds, listings, the search
  for (const f of ["lib/publicApi.ts", "lib/shopRows.ts", "lib/aiSearch.ts", "lib/blogFeed.ts", "lib/siteFiles.ts", "components/ShopProducts.tsx", "components/ShopList.tsx", "components/ChatSearch.tsx", "app/sitemap.ts"]) {
    const text = await Deno.readTextFile(new URL(f, src)).catch(() => "");
    assert(!/photo_|item_photo|product-photos|productPhoto/i.test(text.replace(/photo_read|photo_match|photo\.read|photo\.match/g, "")), `no product photo in ${f}`);
  }
});
