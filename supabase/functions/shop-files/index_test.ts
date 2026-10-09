// Unit tests of shop-files: a signed address only when the database allows the file.
// Run: npm run test:functions
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { signFile } from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

const ID = "44444444-2222-4333-8444-555555555555";

function fake(path: string | null) {
  const log: string[] = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      log.push(`${name} ${JSON.stringify(args)}`);
      return Promise.resolve({ data: path, error: null });
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: (p: string, seconds: number) => {
          log.push(`sign ${bucket} ${p} ${seconds}`);
          return Promise.resolve({ data: { signedUrl: `https://project.supabase.co/storage/v1/object/sign/${p}?token=t` }, error: null });
        },
      }),
    },
  };
  return { db: db as unknown as SupabaseClient, log };
}

const request = (body: Record<string, unknown>) =>
  new Request("http://localhost/shop-files", { method: "POST", body: JSON.stringify(body) });

Deno.test("A file the database allows: a 10-minute signed address", async () => {
  const { db, log } = fake("shop/pictures/x.webp");
  const response = await signFile(request({ slug: "potraviny-centrum", kind: "picture", id: ID, token: "T".repeat(40) }), db);
  eq([response.status, await response.json()], [200, {
    url: "https://project.supabase.co/storage/v1/object/sign/shop/pictures/x.webp?token=t",
    expires_in: 600,
  }], "signed");
  eq(log, [
    `shop_file_path {"p_slug":"potraviny-centrum","p_kind":"picture","p_id":"${ID}","p_session_token":"${"T".repeat(40)}"}`,
    "sign shop-docs shop/pictures/x.webp 600",
  ], "the database decides, then storage signs");
});

Deno.test("A private file without a valid session, or anything else not allowed: 404 and nothing signed", async () => {
  const { db, log } = fake(null);
  const response = await signFile(request({ slug: "potraviny-centrum", kind: "document", id: ID, token: null }), db);
  eq(response.status, 404, "refused");
  eq(log.some((l) => l.startsWith("sign")), false, "nothing signed");
});

Deno.test("Bad requests never reach the database", async () => {
  const { db, log } = fake("x");
  for (const body of [
    { slug: "Potraviny Centrum", kind: "picture", id: ID },
    { slug: "potraviny-centrum", kind: "stock", id: ID },
    { slug: "potraviny-centrum", kind: "picture", id: "1 or 1=1" },
  ]) {
    eq((await signFile(request(body), db)).status, 400, JSON.stringify(body));
  }
  eq(log, [], "no calls");
  const long = fake(null);
  await signFile(request({ slug: "a", kind: "picture", id: ID, token: "x".repeat(500) }), long.db);
  eq(long.log[0].includes('"p_session_token":null'), true, "an over-long token counts as none");
});
