/**
 * Why an Edge Function call failed. supabase-js `functions.invoke` only says "Edge Function
 * returned a non-2xx status code"; the answer itself says more. Our functions always answer
 * {error, message}. Supabase answers {code, message} when it refuses before our code runs:
 * 404 NOT_FOUND (no function with that name), 401 (its "Verify JWT" is on), 503 BOOT_ERROR
 * (the pasted code does not start), 546 WORKER_LIMIT. Nothing here holds a token or a key.
 */
export interface FunctionFailure {
  status: number | null;
  /** Our function's own reason ("not_configured", "login", …); null when Supabase refused. */
  error: string | null;
  /** Our function's message, or Supabase's. */
  message: string | null;
  /** Supabase's own refusal, when our code did not answer. */
  platform: "missing" | "jwt" | "boot" | "limit" | null;
  /** One short line for the owner, e.g. "HTTP 404 NOT_FOUND: Requested function was not found". */
  detail: string;
}

const text = (value: unknown, max = 160): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : typeof value === "number" ? String(value) : null;

export async function functionFailure(error: unknown): Promise<FunctionFailure> {
  const context = (error as { context?: unknown } | null)?.context;
  const fallback = (error as { message?: unknown } | null)?.message;
  if (!(context instanceof Response)) {
    const message = text(fallback) ?? "no answer";
    return { status: null, error: null, message, platform: null, detail: message };
  }
  const status = context.status;
  const body = await context
    .clone()
    .text()
    .catch(() => "");
  let answer: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") answer = parsed as Record<string, unknown>;
  } catch {
    answer = null;
  }
  const ours = text(answer?.error, 60);
  const message = text(answer?.message) ?? text(answer?.msg) ?? (answer ? null : text(body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")));
  if (ours) return { status, error: ours, message, platform: null, detail: message ?? ours };
  const code = text(answer?.code, 60);
  const platform =
    status === 404 || code === "NOT_FOUND"
      ? "missing"
      : status === 401 || status === 403 || code?.startsWith("UNAUTHORIZED")
        ? "jwt"
        : status === 503 || code === "BOOT_ERROR"
          ? "boot"
          : status === 546 || code === "WORKER_LIMIT"
            ? "limit"
            : null;
  const detail = [`HTTP ${status}`, code && code !== String(status) ? code : null].filter(Boolean).join(" ") + (message ? `: ${message}` : "");
  return { status, error: null, message, platform, detail };
}
