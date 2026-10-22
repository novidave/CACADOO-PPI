/**
 * Server errors → "Chyby za posledných 7 dní" (database update 42) and, when SENTRY_DSN is set, Sentry too.
 * Only the kind, the route's file path (/[lang]/shops/[slug], never the visitor's address or query), a cleaned message
 * and React's digest leave the server: no IP, headers, cookies, e-mail addresses, ids or keys. Never throws, never waits
 * longer than 3 s. Shared by src/instrumentation.ts and the tests.
 */

export type ErrorKind = "render" | "route" | "action" | "proxy" | "other";

/** E-mail addresses, URL queries, ids, long numbers and key-like strings out (the database cleans once more). */
export function cleanErrorText(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[e-mail]")
    .replace(/\?[^\s"')]*/g, "?…")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[id]")
    .replace(/[A-Za-z0-9_-]{24,}|\d{6,}/g, "[…]")
    .slice(0, 500);
}

export function errorKind(routeType: string | undefined): ErrorKind {
  return routeType === "render" || routeType === "route" || routeType === "action" || routeType === "proxy" ? routeType : "other";
}

/** https://<key>@<host>/<project> → the envelope address and key; anything else → null. */
export function sentryTarget(dsn: string | undefined): { url: string; key: string } | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\/+|\/+$/g, "");
    if (u.protocol !== "https:" || !u.username || !/^\d+$/.test(project)) return null;
    return { url: `https://${u.host}/api/${project}/envelope/`, key: u.username };
  } catch {
    return null;
  }
}

export interface ServerError {
  kind: ErrorKind;
  route: string;
  message: string;
  digest?: string;
}

export function describeError(err: unknown, routePath: string | undefined, routeType: string | undefined): ServerError {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest).slice(0, 64) : undefined;
  return { kind: errorKind(routeType), route: (routePath || "?").split("?")[0].slice(0, 200), message: cleanErrorText(raw), digest };
}

export async function reportServerError(e: ServerError, env: Record<string, string | undefined> = process.env): Promise<void> {
  const signal = AbortSignal.timeout(3000);
  const jobs: Promise<unknown>[] = [];
  const base = env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (base && anon) {
    jobs.push(
      fetch(`${base}/rest/v1/rpc/log_server_error`, {
        method: "POST",
        headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_kind: e.kind, p_route: e.route, p_message: e.message, p_digest: e.digest ?? null }),
        signal,
        cache: "no-store",
      }),
    );
  }
  const sentry = sentryTarget(env.SENTRY_DSN);
  if (sentry) {
    const id = crypto.randomUUID().replace(/-/g, "");
    const event = {
      event_id: id,
      timestamp: Date.now() / 1000,
      platform: "javascript",
      level: "error",
      transaction: e.route,
      tags: { kind: e.kind, ...(e.digest ? { digest: e.digest } : {}) },
      exception: { values: [{ type: e.message.split(":")[0] || "Error", value: e.message }] },
    };
    jobs.push(
      fetch(sentry.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${sentry.key}` },
        body: `${JSON.stringify({ event_id: id, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}`,
        signal,
        cache: "no-store",
      }),
    );
  }
  await Promise.allSettled(jobs);
}
