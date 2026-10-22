import { assertEquals } from "jsr:@std/assert@1";
import { cleanErrorText, describeError, errorKind, sentryTarget } from "./errorLog.ts";

// A key-like string (made up; put together here so it never looks like a real key in the source).
const FAKE_KEY = ["sk", "live", "x".repeat(24)].join("_");

Deno.test("error log: no personal data leaves the server", () => {
  const text = cleanErrorText(`failed for jana@obchod.sk at /sk/shops/x?q=mlieko&token=abc id 3f2c1b9e-1111-2222-3333-444455556666 ${FAKE_KEY} 0905123456`);
  assertEquals(text.includes("jana@"), false);
  assertEquals(text.includes("mlieko"), false);
  assertEquals(text.includes("3f2c1b9e"), false);
  assertEquals(text.includes("sk_live"), false);
  assertEquals(text.includes("0905123456"), false);
  assertEquals(cleanErrorText("x".repeat(900)).length <= 500, true);
});

Deno.test("error log: the route's file path, never the address", () => {
  const e = describeError(Object.assign(new Error("boom"), { digest: "123abc" }), "/[lang]/shops/[slug]?x=1", "render");
  assertEquals(e, { kind: "render", route: "/[lang]/shops/[slug]", message: "Error: boom", digest: "123abc" });
  assertEquals(errorKind("weird"), "other");
});

Deno.test("error log: Sentry only with a real https DSN", () => {
  assertEquals(sentryTarget(undefined), null);
  assertEquals(sentryTarget("not a dsn"), null);
  assertEquals(sentryTarget("http://k@o1.ingest.sentry.io/42"), null);
  assertEquals(sentryTarget("https://abc@o1.ingest.sentry.io/42"), { url: "https://o1.ingest.sentry.io/api/42/envelope/", key: "abc" });
});
