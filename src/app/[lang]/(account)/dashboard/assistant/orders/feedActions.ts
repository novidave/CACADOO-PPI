"use server";

import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { getSession } from "@/lib/auth";
import { foodFeed, type FoodFeed, type FoodOrder } from "@/lib/foodOwner";
import { payBySquareSvg } from "@/lib/payBySquare";

/**
 * Objednávky jedla → the feed (database update 81). The feed calls these with the owner's own login and draws the
 * answer: every write returns the feed again as SQL sees it (owner_food_feed), so the screen never guesses. Every rule
 * is in SQL (owner_food_order_finish / _reopen: the step's UUID once, payment first, stock once, the same day;
 * owner_food_set_delay, owner_food_save_settings, owner_food_pause, owner_food_assign: members + the plan); nothing
 * here is trusted beyond the shape of the arguments.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = [
  "step", "not_paid", "cash", "already_paid", "pay_method", "no_plan", "not_found", "conflict", "courier", "courier_app",
  "too_late", "delay", "settings", "forbidden",
] as const;

export type FeedAnswer = { ok: true; feed: FoodFeed; sms?: "sent" | "failed" } | { ok: false; error: string; feed?: FoodFeed };

const reason = (message: string | undefined) => {
  const found = REASONS.find((r) => r === message);
  return found ? `err_${found === "forbidden" ? "failed" : found}` : "err_failed";
};

async function owner() {
  const session = await getSession();
  return session?.supabase ?? null;
}

/** The feed after a write (or the error with the feed as it is now, so the card goes back to where SQL has it). */
async function answer(supabase: NonNullable<Awaited<ReturnType<typeof owner>>>, shopId: string, error?: { message: string } | null): Promise<FeedAnswer> {
  const feed = await foodFeed(supabase, shopId);
  if (error) return { ok: false, error: reason(error.message), ...(feed ? { feed } : {}) };
  return feed ? { ok: true, feed } : { ok: false, error: "err_failed" };
}

/** The feed again (FoodOrdersLive's refresh, or "Zobraziť staršie" with the last 7 days). */
export async function loadFeed(shopId: string, older = false): Promise<FeedAnswer> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId)) return { ok: false, error: "err_failed" };
  const feed = await foodFeed(supabase, shopId, older === true);
  return feed ? { ok: true, feed } : { ok: false, error: "err_failed" };
}

/** "Meškanie": 0, +10, +20, +30, +45 (one tap saves). */
export async function setFeedDelay(shopId: string, minutes: number): Promise<FeedAnswer> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId) || !Number.isInteger(minutes)) return { ok: false, error: "err_failed" };
  const { error } = await supabase.rpc("owner_food_set_delay", { p_shop_id: shopId, p_minutes: minutes });
  return answer(supabase, shopId, error);
}

/** "Príprava" / "Donáška" − n min + (only that one field changes). */
export async function setFeedTime(shopId: string, field: "prep_minutes" | "delivery_minutes", minutes: number): Promise<FeedAnswer> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId) || !Number.isInteger(minutes) || (field !== "prep_minutes" && field !== "delivery_minutes")) {
    return { ok: false, error: "err_failed" };
  }
  const { error } = await supabase.rpc("owner_food_save_settings", { p_shop_id: shopId, p: { [field]: minutes } });
  return answer(supabase, shopId, error);
}

/** "Pozastaviť príjem" / "Spustiť príjem". */
export async function setFeedPaused(shopId: string, paused: boolean): Promise<FeedAnswer> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId)) return { ok: false, error: "err_failed" };
  const { error } = await supabase.rpc("owner_food_pause", { p_shop_id: shopId, p_paused: paused === true });
  return answer(supabase, shopId, error);
}

/**
 * "Vybavené" (a swipe or the button): food_order_finish with the step's own UUID (a retry is the same step), the payment
 * chosen in the feed when there was none. Handed to the courier with "SMS „Objednávka je na ceste“" on → that SMS
 * (written down first in SQL, once per order, by the crm-messages function).
 */
export async function finishFeedOrder(
  shopId: string,
  orderId: string,
  stepId: string,
  pay?: "qr" | "cash" | "card" | null,
  cashCents?: number | null,
  courierId?: string | null,
  assignStepId?: string | null,
): Promise<FeedAnswer> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId) || !UUID.test(orderId) || !UUID.test(stepId)) return { ok: false, error: "err_failed" };
  const method = pay === "qr" || pay === "cash" || pay === "card" ? pay : null;
  const cash = method === "cash" && Number.isInteger(cashCents) && (cashCents as number) >= 0 ? (cashCents as number) : null;
  if (courierId) {
    if (!UUID.test(courierId) || !assignStepId || !UUID.test(assignStepId)) return { ok: false, error: "err_failed" };
    const assigned = await supabase.rpc("owner_food_assign", {
      p_shop_id: shopId, p_order_id: orderId, p_courier_id: courierId, p_step_id: assignStepId,
    });
    if (assigned.error) return answer(supabase, shopId, assigned.error);
  }
  const { data, error } = await supabase.rpc("owner_food_order_finish", {
    p_shop_id: shopId, p_order_id: orderId, p_step_id: stepId, p_pay_method: method, p_cash_given_cents: cash,
  });
  if (error) return answer(supabase, shopId, error);
  let sms: "sent" | "failed" | undefined;
  const done = data as { status?: string; duplicate?: boolean } | null;
  if (done?.status === "on_the_way" && !done.duplicate) {
    const settings = await supabase.rpc("owner_food_settings", { p_shop_id: shopId });
    if ((settings.data as { sms_on_the_way?: boolean } | null)?.sms_on_the_way) {
      const sent = await supabase.functions.invoke<{ status?: string }>("crm-messages", {
        body: { action: "food_sms", shop_id: shopId, order_id: orderId },
      });
      sms = !sent.error && sent.data?.status && sent.data.status !== "failed" ? "sent" : "failed";
    }
  }
  const res = await answer(supabase, shopId);
  return res.ok && sms ? { ...res, sms } : res;
}

/** "Vrátiť" / "Späť": food_order_reopen with the step's own UUID (the same day only; stock back once). */
export async function reopenFeedOrder(shopId: string, orderId: string, stepId: string): Promise<FeedAnswer> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId) || !UUID.test(orderId) || !UUID.test(stepId)) return { ok: false, error: "err_failed" };
  const { error } = await supabase.rpc("owner_food_order_reopen", { p_shop_id: shopId, p_order_id: orderId, p_step_id: stepId });
  return answer(supabase, shopId, error);
}

/**
 * "QR" in the feed's payment dialog (2026-11-05): the order's PAY by square code, drawn on the server exactly as on the
 * order's page (owner_food_order decides who may read the order; the shop's IBAN from Sklad). null = no IBAN, already
 * paid, or the order could not be read — the dialog then offers the order's page instead.
 */
export async function feedOrderQr(shopId: string, orderId: string, lang: string): Promise<{ svg: string; payee: string; iban: string; vs: string } | null> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId) || !UUID.test(orderId)) return null;
  const { data, error } = await supabase.rpc("owner_food_order", { p_shop_id: shopId, p_order_id: orderId });
  const o = (error ? null : data) as FoodOrder | null;
  if (!o || !o.iban || o.paid_at) return null;
  const dict = await getDictionary(isLocale(lang) ? lang : "sk");
  const payee = o.payee ?? o.shop_name;
  const svg = await payBySquareSvg({
    iban: o.iban,
    bic: o.bic ?? null,
    payee,
    amount: o.total_cents / 100,
    vs: o.vs,
    message: t(dict.food.qr_message, { n: o.number }),
  }).catch(() => null);
  return svg ? { svg, payee, iban: o.iban, vs: o.vs } : null;
}
