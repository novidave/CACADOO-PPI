import { test } from "node:test";
import assert from "node:assert/strict";
import { pair, status, upload } from "../src/core/api";
import type { Binding, Batch } from "../src/core/model";
const binding: Binding = {
  deviceId: "00000000-0000-4000-8000-000000000001",
  shopId: "00000000-0000-4000-8000-000000000002",
  sourceId: "00000000-0000-4000-8000-000000000003",
  generation: 1,
  token: "device-test-token",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
};
const batch: Batch = {
  id: "hash-identity",
  sourceTimestamp: new Date().toISOString(),
  hash: "content-hash",
  csv: "source_code;name;quantity;price;currency\n1;Tea;2;3;EUR\n",
  rows: 1,
  createdAt: Date.now(),
  attempts: 0,
  nextAt: Date.now(),
  generation: 1,
};
test("pairing sends only code; expired device rejected", async () => {
  await pair("https://example.org", "ABCD", async (url, init) => {
    assert(url.endsWith("/agent-pair"));
    assert.deepEqual(JSON.parse(String(init!.body)), {
      version: 1,
      code: "ABCD",
    });
    return binding;
  });
  await assert.rejects(
    pair("https://example.org", "ABCD", async () => ({
      ...binding,
      expiresAt: new Date(0).toISOString(),
    })),
    /PAIR_EXPIRED/,
  );
});
test("revocation, source handoff and mapping approval fail closed", async () => {
  const good = {
    active: true,
    generation: 1,
    mappingApproved: true,
    mappingVersion: "m1",
    latestSourceTime: null,
  };
  for (const patch of [
    { active: false },
    { generation: 2 },
    { mappingApproved: false },
  ])
    await assert.rejects(
      status("https://example.org", binding, async () => ({
        ...good,
        ...patch,
      })),
    );
});
test("retry after lost response keeps payload and identity; receipt must match source", async () => {
  const requests: RequestInit[] = [];
  let calls = 0;
  const fake = async (_url: string, init?: RequestInit) => {
    requests.push(init!);
    if (++calls === 1) throw Error("REQUEST_TIMEOUT");
    return {
      status: "updated",
      idempotencyKey: batch.id,
      sourceId: binding.sourceId,
      generation: 1,
    };
  };
  await assert.rejects(
    upload("https://example.org", binding, batch, "m1", fake),
  );
  await upload("https://example.org", binding, batch, "m1", fake);
  assert.deepEqual(requests[0], requests[1]);
  await assert.rejects(
    upload("https://example.org", binding, batch, "m1", async () => ({
      status: "updated",
      idempotencyKey: batch.id,
      sourceId: "another-shop",
      generation: 1,
    })),
    /UPLOAD_REJECTED/,
  );
});
test("HTTP-level success is not stock success; approval waits and old generations never upload", async () => {
  await assert.rejects(
    upload("https://example.org", binding, batch, "m1", async () => ({
      status: "waiting_for_approval",
    })),
    /MAPPING_NOT_APPROVED/,
  );
  await assert.rejects(
    upload(
      "https://example.org",
      binding,
      { ...batch, generation: 0 },
      "m1",
      async () => {
        throw Error("SHOULD_NOT_CALL");
      },
    ),
    /SOURCE_NOT_ACTIVE/,
  );
});
