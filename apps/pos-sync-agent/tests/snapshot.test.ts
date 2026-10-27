import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshot, csvRows, parseFile } from "../src/core/snapshot";
import { configSchema, type Config } from "../src/core/model";
const config: Config = {
  backend: "https://example.org",
  kind: "file",
  mapping: {
    source_code: "Code",
    name: "Name",
    quantity: "Qty",
    price: "Price",
    currency: "Currency",
  },
  expectedRows: 2,
  knowledge: "reported_stock",
  intervalMinutes: 15,
};
const rows = [
  {
    Code: "1",
    Name: "Káva",
    Qty: "12",
    Price: "2,99",
    Currency: "EUR",
    Supplier: "PRIVATE",
  },
  {
    Code: "2",
    Name: "Tea",
    Qty: "0",
    Price: "3.50",
    Currency: "EUR",
    Supplier: "PRIVATE",
  },
];
const now = Date.now(),
  time = new Date(now - 120000).toISOString();
test("only approved public fields leave the PC; quantities and decimal strings preserved", () => {
  const batch = snapshot(rows, config, time, 2, now);
  assert(!batch.csv.includes("PRIVATE"));
  assert(!batch.csv.includes("Supplier"));
  const result = csvRows(batch.csv);
  assert.equal(result[0].quantity, "12");
  assert.equal(result[0].price, "2,99");
  assert.equal(result[1].quantity, "0");
});
test("retries keep identical idempotency identity; source generation and content change it", () => {
  const a = snapshot(rows, config, time, 2, now),
    b = snapshot(rows, config, time, 2, now + 1000);
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, snapshot(rows, config, time, 3, now).id);
  assert.notEqual(
    a.id,
    snapshot([{ ...rows[0], Qty: "11" }, rows[1]], config, time, 2, now).id,
  );
});
test("partial and empty snapshots never apply", () => {
  assert.throws(
    () => snapshot(rows.slice(0, 1), config, time, 1, now),
    /INCOMPLETE/,
  );
  assert.throws(() => snapshot([], config, time, 1, now), /INCOMPLETE/);
});
test("unknown quantity never becomes zero, negatives remain source values", () => {
  assert.throws(
    () => snapshot([{ ...rows[0], Qty: "" }, rows[1]], config, time, 1, now),
    /INVALID_ROW/,
  );
  assert(
    snapshot(
      [{ ...rows[0], Qty: "-1" }, rows[1]],
      config,
      time,
      1,
      now,
    ).csv.includes('"-1"'),
  );
});
test("duplicate identifiers and truncation are rejected", () => {
  assert.throws(
    () => snapshot([rows[0], { ...rows[1], Code: "1" }], config, time, 1, now),
    /DUPLICATE/,
  );
  assert.throws(
    () =>
      snapshot(
        [{ ...rows[0], Code: "X".repeat(101) }, rows[1]],
        config,
        time,
        1,
        now,
      ),
    /INVALID_ROW/,
  );
});
test("private mapping and ambiguous mappings are rejected", () => {
  assert.throws(
    () =>
      snapshot(
        rows,
        { ...config, mapping: { ...config.mapping, price: "Supplier" } },
        time,
        1,
        now,
      ),
    /UNSAFE/,
  );
  assert.throws(
    () =>
      snapshot(
        rows,
        { ...config, mapping: { ...config.mapping, price: "Qty" } },
        time,
        1,
        now,
      ),
    /UNSAFE/,
  );
});
test("future or stale observation cannot be relabelled fresh", () => {
  assert.throws(
    () => snapshot(rows, config, new Date(now + 120000).toISOString(), 1, now),
    /SOURCE_TIME/,
  );
  assert.throws(
    () =>
      snapshot(rows, config, new Date(now - 86400001).toISOString(), 1, now),
    /SOURCE_TIME/,
  );
});
test("CSV quoting, separators and repeated headers", () => {
  const a = csvRows('Code;Name;Qty\r\n1;"Milk; fresh";2\r\n');
  assert.equal(a[0].Name, "Milk; fresh");
  assert.throws(() => csvRows("a;a\n1;2"), /DUPLICATE/);
});
test("XML rejects DTD and ambiguous record sets", async () => {
  await assert.rejects(
    parseFile(Buffer.from("<!DOCTYPE x><x/>"), "stock.xml"),
    /XML_INVALID/,
  );
  await assert.rejects(
    parseFile(
      Buffer.from(
        "<x><a><v>1</v></a><a><v>2</v></a><b><v>3</v></b><b><v>4</v></b></x>",
      ),
      "stock.xml",
    ),
    /AMBIGUOUS/,
  );
});
test("catalog and estimated sources cannot be enabled through config", () => {
  assert(
    !configSchema.safeParse({ ...config, knowledge: "catalog_only" }).success,
  );
  assert(
    !configSchema.safeParse({ ...config, knowledge: "estimated_stock" })
      .success,
  );
});

test("bundled sample runs through parsing and filtering without contacting an API", async () => {
  const { readFile, stat } = await import("node:fs/promises");
  const bytes = await readFile("samples/stock.csv");
  const sourceRows = await parseFile(bytes, "stock.csv");
  const canonical = {
    ...config,
    mapping: {
      source_code: "source_code",
      name: "name",
      quantity: "quantity",
      price: "price",
      currency: "currency",
      ean: "ean",
      brand: "brand",
    },
  };
  const result = snapshot(sourceRows, canonical, time, 1, now);
  assert.equal(result.rows, 2);
  assert(!result.csv.includes("purchase_cost"));
  assert(!result.csv.includes("1,10"));
});
test("XLSX inflated-size limit is checked before workbook parsing", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const zip = Buffer.from(zipSync({ "a.txt": strToU8("small") }));
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(51 * 1024 * 1024, central + 24);
  await assert.rejects(parseFile(zip, "stock.xlsx"), /FILE_SIZE/);
});
