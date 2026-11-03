import { isLocale } from "@/i18n/config";
import { courierCall, type CourierOrder } from "@/lib/courier";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A same-site courier page to go to ("/sk/kurier…" only); anything else → the courier's start. */
function safePath(value: unknown, lang: string): string {
  const v = String(value ?? "");
  return v.startsWith(`/${lang}/kurier`) && !v.includes("//") && !v.includes("\\") ? v : `/${lang}/kurier`;
}

/** Euros as typed ("50", "50,5", "50.50") → cents; nothing usable → null. */
function cents(euros: unknown): number | null {
  const v = String(euros ?? "").trim().replace(",", ".");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
}

/**
 * A courier's step (database update 75): "Na ceste", a payment mark, "Doručené", "Problém s donáškou". JSON from the
 * page's script (it retries the same step id on a weak signal) or a plain form without JavaScript (answered with a
 * redirect). Only the courier's own key (the signed cookie) and the door food_courier_call decide.
 */
export async function POST(request: Request) {
  const asJson = (request.headers.get("content-type") ?? "").includes("application/json");
  const body = (asJson
    ? ((await request.json().catch(() => ({}))) as Record<string, unknown>)
    : Object.fromEntries((await request.formData().catch(() => new FormData())).entries())) as Record<string, unknown>;
  const lang = isLocale(String(body.lang ?? "")) ? String(body.lang) : "sk";
  const next = safePath(body.next, lang);
  const back = safePath(body.back, lang);
  const answer = (status: number, payload: Record<string, unknown>) => {
    if (asJson) return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
    const to = payload.error ? `${back}${back.includes("?") ? "&" : "?"}err=${encodeURIComponent(String(payload.error))}` : next;
    return Response.redirect(new URL(payload.error === "courier" ? `/${lang}/kurier` : to, request.url), 303);
  };

  const fn = body.fn === "problem" ? "problem" : body.fn === "step" ? "step" : null;
  const order = String(body.order_id ?? "");
  const step = String(body.step_id ?? "");
  if (!fn || !UUID.test(order) || !UUID.test(step)) return answer(400, { error: "bad_request" });
  const args: Record<string, unknown> = { order_id: order, step_id: step };
  if (fn === "problem") {
    args.reason = String(body.reason ?? "").slice(0, 200);
  } else {
    if (body.to === "on_the_way" || body.to === "delivered") args.to = body.to;
    if (body.pay_method === "qr" || body.pay_method === "cash" || body.pay_method === "card") args.pay_method = body.pay_method;
    if (args.pay_method === "cash") {
      // a quick amount (cents) or "Iná suma" in euros; "Presne" = the total (the database knows it)
      const given = body.cash_other ? cents(body.cash_other) : body.cash_given_cents ? Number(body.cash_given_cents) : null;
      if (body.cash_other && given === null) return answer(400, { error: "cash" });
      if (given !== null && Number.isFinite(given)) args.cash_given_cents = Math.round(given);
    }
  }
  const { data, error } = await courierCall<CourierOrder>(fn, args);
  if (error) {
    const status = error === "courier" ? 401 : error === "too_many" ? 429 : error === "failed" || error === "unavailable" ? 502 : 400;
    return answer(status, { error });
  }
  return answer(200, { ok: true, status: data?.status ?? null, paid: data?.paid ?? null });
}
