import { test } from "node:test";
import assert from "node:assert/strict";
import { publicAddress, restSnapshot } from "../src/core/network";
import { assertHttps, type Config } from "../src/core/model";
const config: Config = {
  backend: "https://example.org",
  kind: "rest",
  mapping: {
    source_code: "id",
    name: "name",
    price: "price",
    quantity: "qty",
    currency: "currency",
  },
  expectedRows: 3,
  knowledge: "reported_stock",
  intervalMinutes: 15,
  rest: {
    url: "https://vendor.example/products",
    itemsPath: "data.items",
    totalPath: "data.total",
    timePath: "data.time",
    pageParam: "page",
    pageSizeParam: "limit",
    pageSize: 2,
    token: "test-token",
  },
};
const time = new Date().toISOString();
test("private, loopback, link-local, carrier-grade NAT and IPv6 destinations blocked", () => {
  for (const a of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.2",
    "169.254.169.254",
    "100.64.1.2",
    "::1",
    "::ffff:127.0.0.1",
  ])
    assert(!publicAddress(a), a);
  assert(publicAddress("8.8.8.8"));
});
test("HTTPS credentials, fragments and plaintext HTTP refused", () => {
  for (const u of [
    "http://example.org",
    "https://user:pass@example.org",
    "https://example.org/#x",
  ])
    assert.throws(() => assertHttps(u));
});
test("REST numbered pages reconcile total and immutable timestamp", async () => {
  const seen: string[] = [];
  const data = await restSnapshot(config, async (url, init) => {
    seen.push(url);
    assert.equal(
      (init!.headers as Record<string, string>).Authorization,
      "Bearer test-token",
    );
    return {
      data: {
        items: seen.length === 1 ? [{ id: "1" }, { id: "2" }] : [{ id: "3" }],
        total: 3,
        time,
      },
    };
  });
  assert.equal(data.rows.length, 3);
  assert.equal(new URL(seen[1]).searchParams.get("page"), "2");
});
test("REST changing snapshot, wrong total and empty partial page stop acquisition", async () => {
  let calls = 0;
  await assert.rejects(
    restSnapshot(config, async () => ({
      data: {
        items: [{ id: String(++calls) }],
        total: 3,
        time: calls === 1 ? time : new Date(0).toISOString(),
      },
    })),
    /CHANGED/,
  );
  await assert.rejects(
    restSnapshot(config, async () => ({ data: { items: [], total: 3, time } })),
    /INCOMPLETE/,
  );
  await assert.rejects(
    restSnapshot(config, async () => ({
      data: { items: [{ id: "1" }], total: 2, time },
    })),
    /INCOMPLETE/,
  );
});
