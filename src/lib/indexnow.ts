/**
 * IndexNow (update 36): one key for every host, INDEXNOW_KEY (public by design — the same value
 * is a Supabase secret of stock-pull, which sends the pings). Each host serves it as
 * https://<host>/<key>.txt: the main Cacadoo domain (/api/indexnow/<key>) and every live own
 * domain (/api/site/<slug>/indexnow/<key>); src/proxy.ts sends "/<key>.txt" there.
 */
export const INDEXNOW_KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

/** INDEXNOW_KEY when it is a valid IndexNow key (8–128 letters, digits or dashes), else null. */
export function indexNowKey(env: Record<string, string | undefined> = process.env): string | null {
  const key = (env.INDEXNOW_KEY ?? "").trim();
  return INDEXNOW_KEY_PATTERN.test(key) ? key : null;
}

/** The key file: the key itself as plain text, only for exactly that name; anything else → 404. */
export function keyFileResponse(asked: string, key: string | null): Response {
  if (!key || asked !== key) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(key, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
}
