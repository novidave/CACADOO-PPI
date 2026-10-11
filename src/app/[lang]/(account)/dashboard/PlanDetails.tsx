import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { formatDate } from "@/lib/format";
import { PendingButton } from "@/components/PendingButton";
import { openBilling } from "./actions";

/** The shop's row in subscriptions (written only by the Stripe functions). */
export interface PlanRow {
  status: string;
  plan: string | null;
  current_period_end: string | null;
  cancel_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

/** Subscriptions that still bill or can come back: managed in the Stripe customer portal. */
export const LIVE_PLAN = ["trialing", "active", "past_due", "unpaid", "paused"];

/**
 * Current plan, the subscription's state and date, "Upgrade" and "Manage subscription"
 * (on "Predplatné a doména"; Stripe brings the owner back there).
 */
export function PlanDetails({
  plan,
  shop,
  lang,
  dict,
}: {
  plan: { row: PlanRow | null; active: boolean };
  shop: { id: string; slug: string; ico: string | null; timezone: string };
  lang: Locale;
  dict: Dictionary;
}) {
  const p = dict.plan;
  const row = plan.row;
  const subscribed = Boolean(row?.stripe_subscription_id) && row?.status !== "none";
  const live = subscribed && LIVE_PLAN.includes(row?.status ?? "");
  const until = row?.cancel_at ?? row?.current_period_end ?? null;
  const statusText = row ? ((p as Record<string, string>)[`status_${row.status}`] ?? row.status) : "";
  const hidden = (intent: string) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="shop_id" value={shop.id} />
      <input type="hidden" name="shop_slug" value={shop.slug} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="back" value="plan" />
    </>
  );
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted">{p.current}</dt>
        <dd className="font-semibold" data-plan={plan.active ? "pro" : "free"}>
          {plan.active ? p.pro : p.free}
        </dd>
        {subscribed && (
          <>
            <dt className="text-muted">{p.status}</dt>
            <dd>{statusText}</dd>
          </>
        )}
        {plan.active && until && (
          <>
            <dt className="text-muted">{row?.cancel_at ? p.ends : p.renews}</dt>
            <dd>{formatDate(until, lang, shop.timezone)}</dd>
          </>
        )}
      </dl>
      {(row?.status === "past_due" || row?.status === "unpaid") && <p className="text-sm font-medium">{p.payment_problem}</p>}
      <p className="text-sm text-muted">{p.intro}</p>
      <div className="flex flex-wrap gap-2">
        {!live && (
          <form action={openBilling}>
            {hidden("checkout")}
            <PendingButton pending={p.opening}>{p.upgrade}</PendingButton>
          </form>
        )}
        {subscribed && (
          <form action={openBilling}>
            {hidden("portal")}
            <PendingButton pending={p.opening}>{p.manage}</PendingButton>
          </form>
        )}
      </div>
      {!live && !shop.ico && <p className="text-sm text-muted">{p.company_tip}</p>}
    </>
  );
}
