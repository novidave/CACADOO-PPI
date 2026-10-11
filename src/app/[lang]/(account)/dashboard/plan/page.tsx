import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { callDomains, type DomainOrder, euros, loadDomainPage, OPEN_STATUSES, OWNER_FIELDS } from "@/lib/domains";
import { formatDate } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { DbError } from "@/components/DbError";
import { DomainStatus, type DomainView } from "@/components/DomainStatus";
import { DomainWizard, type WizardCheck } from "@/components/DomainWizard";
import { PendingButton } from "@/components/PendingButton";
import { PlanDetails, type PlanRow } from "../PlanDetails";
import { cancelDomainPayment, checkDomain, connectDomain, disconnectDomain, payDomain, requestAuthCode, saveLegal } from "./actions";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/plan">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).domains.title };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** What the progress screen starts from (the same shape the polling route answers with). */
function domainView(o: DomainOrder): DomainView {
  return {
    id: o.id,
    kind: o.kind,
    hostname: o.hostname,
    site_host: o.site_host,
    status: o.status,
    test_mode: o.test_mode,
    dns_records: o.kind === "connected" ? o.dns_records : null,
    auto_dns: o.kind === "connected" && Boolean(o.registrar_service_id),
    last_check_at: o.last_check_at,
    next_check_at: o.next_check_at,
    live_at: o.live_at,
    email_sent: Boolean(o.live_email_at),
    expires_at: o.expires_at,
  };
}

/**
 * "Predplatné a doména": the plan, its payment, the shop's own domain and its renewal on one
 * page. Flow 13 (find on Websupport → paste → pay → live) and flow 14 (connect an own domain).
 */
export default async function PlanPage({ params, searchParams }: PageProps<"/[lang]/dashboard/plan">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const sp = await searchParams;
  const d = dict.domains;

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];

  const [planRow, hasPlanRow, domains] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("status, plan, current_period_end, cancel_at, stripe_customer_id, stripe_subscription_id")
      .eq("shop_id", shop.id)
      .maybeSingle(),
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    loadDomainPage(supabase, shop.id),
  ]);
  const plan = planRow.error || hasPlanRow.error ? null : { row: planRow.data as PlanRow | null, active: hasPlanRow.data === true };
  const hasPlan = plan?.active === true;
  // The Pro price next to the domain, for a shop that does not have Pro yet.
  const proPrice =
    domains && !hasPlan
      ? (await callDomains<{ cents: number | null; currency: string; interval: string | null; interval_count: number }>(supabase, {
          action: "pro_price",
          shop_id: shop.id,
        })).data
      : null;

  const ok = first(sp.ok);
  const err = first(sp.err);
  const paidNow = first(sp.domain) === "paid";
  const current = domains?.current ?? null;
  const open = current && OPEN_STATUSES.includes(current.status) ? current : null;
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="shop_id" value={shop.id} />
      <input type="hidden" name="shop_slug" value={shop.slug} />
    </>
  );
  const okText: Record<string, string> = {
    legal: d.legal_saved,
    connect: "",
    disconnected: d.disconnected,
    auth: "",
    auth_requested: d.auth_requested,
    order_canceled: d.order_canceled,
  };
  const errText: Record<string, string> = {
    legal: d.legal_error,
    terms: d.pay_terms_needed,
    owner: d.pay_owner_needed,
    pay: d.pay_failed,
    in_use: d.in_use,
    not_configured: d.not_configured,
    own_needs_pro: d.own_needs_pro,
    own_in_use: d.own_in_use,
    has_domain: d.has_domain,
    invalid: d.invalid,
    accents: d.accents,
    auth: d.auth_failed,
    confirm: d.error,
    error: d.error,
  };
  const fields = OWNER_FIELDS.map((name) => ({
    name,
    label: (d as Record<string, unknown>)[`field_${name}`] as string,
    required: name !== "dic" && name !== "ic_dph",
    value: (domains?.owner as Record<string, unknown> | null)?.[name] as string | null ?? null,
  }));
  const quote: WizardCheck | null = domains?.quote
    ? {
        state: "available",
        domain: domains.quote.hostname,
        order_id: domains.quote.id,
        price_cents: domains.quote.price_cents ?? undefined,
        renewal_cents: domains.quote.renewal_cents ?? undefined,
        vat_included: domains.quote.vat_included ?? undefined,
        test: domains.quote.test_mode,
      }
    : null;
  const ended = current && !open ? current : null;
  const endedText: Record<string, string> = {
    taken: d.taken_notice,
    failed: d.failed_notice,
    lapsed: d.lapsed_notice,
    ended: d.ended_notice,
    dns_timeout: d.dns_timeout_notice,
  };
  // The transfer code: a bought domain whose plan is cancelled, or that ended or lapsed.
  const transferable =
    current?.kind === "bought" && !current.test_mode && current.registrar_service_id &&
    (Boolean(plan?.row?.cancel_at) || ["ended", "lapsed"].includes(current.status));

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <Link href={`/${lang}/dashboard?${new URLSearchParams({ shop: shop.slug })}`} className="text-sm underline underline-offset-4">
          {d.back}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{d.title}</h1>
        {shops.length > 1 && (
          <nav className="flex flex-wrap gap-3 text-sm" aria-label={dict.dashboard.shop}>
            {shops.map((s) => (
              <Link
                key={s.id}
                href={`/${lang}/dashboard/plan?${new URLSearchParams({ shop: s.slug })}`}
                className={s.id === shop.id ? "font-semibold underline underline-offset-4" : "text-muted hover:underline"}
              >
                {s.name}
              </Link>
            ))}
          </nav>
        )}
        <p className="text-muted">{shop.name}</p>
      </header>

      <section id="plan" className="flex flex-col gap-3" aria-labelledby="plan-heading">
        <h2 id="plan-heading" className="text-lg font-semibold">
          {d.plan_title}
        </h2>
        {first(sp.plan) === "done" && (
          <p role="status" className="border border-foreground p-3 font-medium">
            {hasPlan ? dict.plan.thanks : dict.plan.done}
          </p>
        )}
        {first(sp.plan) === "canceled" && <p role="status" className="border border-line p-3">{dict.plan.canceled}</p>}
        {err?.startsWith("stripe:") && <p className="border border-line p-3">{t(dict.plan.failed, { message: err.slice(7) })}</p>}
        {plan ? <PlanDetails plan={plan} shop={shop} lang={lang} dict={dict} /> : <p className="text-sm text-muted">{dict.plan.unavailable}</p>}
      </section>

      <section id="domain" className="flex flex-col gap-4" aria-labelledby="domain-heading">
        <h2 id="domain-heading" className="text-lg font-semibold">
          {d.domain_title}
        </h2>
        <p className="text-sm text-muted">{d.domain_intro}</p>
        {paidNow && <p role="status" className="border border-foreground p-3 font-medium">{d.paid_notice}</p>}
        {first(sp.domain) === "canceled" && <p role="status" className="border border-line p-3">{d.canceled_notice}</p>}
        {ok && okText[ok] && <p role="status" className="border border-foreground p-3 font-medium">{okText[ok]}</p>}
        {err && errText[err] && <p role="alert" className="border border-line p-3">{errText[err]}</p>}
        {err === "pay_reason" && (
          <p role="alert" className="border border-line p-3">
            {t(d.pay_failed_reason, { message: first(sp.reason) ?? "" })}
          </p>
        )}

        {!domains ? (
          <p className="text-sm text-muted">{d.not_configured}</p>
        ) : open && open.status === "checkout" && !paidNow ? (
          // Stripe's page was left, cancelled or failed: continue paying or give the name up (never a dead end).
          <section className="flex flex-col gap-3 border border-line p-4" data-payment-pending>
            <p className="font-semibold">{t(d.pay_pending, { domain: open.hostname })}</p>
            <form action={payDomain} className="flex flex-col gap-3">
              {hidden}
              <input type="hidden" name="order_id" value={open.id} />
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="accept_terms" required className="mt-1" />
                <span>
                  {d.terms_before}
                  <a href={`/${lang}/podmienky`} target="_blank" rel="noopener" className="underline underline-offset-4">
                    {d.terms_link}
                  </a>
                  {d.terms_and}
                  <a href={`/${lang}/podmienky-domeny`} target="_blank" rel="noopener" className="underline underline-offset-4">
                    {d.domain_terms_link}
                  </a>
                </span>
              </label>
              <PendingButton pending={d.paying}>{d.pay_continue}</PendingButton>
            </form>
            <form action={cancelDomainPayment}>
              {hidden}
              <input type="hidden" name="order_id" value={open.id} />
              <button type="submit" className="text-sm underline underline-offset-4" data-cancel-payment>
                {d.pay_cancel}
              </button>
            </form>
          </section>
        ) : open ? (
          <>
            <DomainStatus
              initial={domainView(open)}
              labels={d as unknown as Parameters<typeof DomainStatus>[0]["labels"]}
              lang={lang}
              timeZone={shop.timezone}
              freshFromPayment={paidNow}
            />
            {open.status === "live" && open.kind === "bought" && !open.test_mode && (
              <div className="flex flex-col gap-1 text-sm">
                {open.expires_at && <p>{t(d.expires, { date: formatDate(open.expires_at, lang, shop.timezone) })}</p>}
                <p className="text-muted">{t(d.renewal_note, { price: euros(open.renewal_cents, lang, open.currency) })}</p>
                {open.renewal_state === "paid" && <p className="font-semibold">{d.renewal_paid}</p>}
                {open.renewal_state === "failed" && (
                  <p className="font-semibold">
                    {d.renewal_failed}{" "}
                    {open.renewal_invoice_url && (
                      <a href={open.renewal_invoice_url} className="underline underline-offset-4">
                        {d.renewal_pay}
                      </a>
                    )}
                  </p>
                )}
              </div>
            )}
            {open.kind === "connected" && (
              <details className="text-sm">
                <summary className="cursor-pointer underline underline-offset-4">{d.disconnect}</summary>
                <form action={disconnectDomain} className="mt-2 flex flex-col gap-2">
                  {hidden}
                  <input type="hidden" name="order_id" value={open.id} />
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="confirm" required />
                    {d.disconnect_confirm}
                  </label>
                  <PendingButton pending={d.checking}>{d.disconnect}</PendingButton>
                </form>
              </details>
            )}
          </>
        ) : (
          <>
            {ended && endedText[ended.status] && (
              <p className="border border-line p-3">{t(endedText[ended.status], { domain: ended.hostname })}</p>
            )}

            <section className="flex flex-col gap-3 border border-line p-4" aria-labelledby="step1" data-step1>
              <h3 id="step1" className="font-semibold">
                {d.step1_title}
              </h3>
              <ol className="flex list-decimal flex-col gap-1 pl-6 text-sm">
                <li>{d.step1_1}</li>
                <li>{d.step1_2}</li>
                <li>{d.step1_3}</li>
              </ol>
              <p className="text-sm font-semibold">{d.step1_warning}</p>
              <a
                href={domains.settings.search_url}
                target="_blank"
                rel="noopener"
                className="self-start rounded border border-foreground px-4 py-2 font-medium"
                data-websupport-search
              >
                {d.search_button}
              </a>
              <p className="flex items-center gap-2 text-sm">
                <span>{d.registrar_note}</span>
                {/* Logo placeholder: the Websupport logo goes here once Websupport allows it. */}
                <span className="inline-block h-6 w-24 border border-dashed border-line" aria-hidden data-websupport-logo />
              </p>
              <div className="border-t border-line pt-3 text-sm">
                <p className="font-semibold">{d.why_title}</p>
                <p>{d.why_text}</p>
              </div>
            </section>

            <DomainWizard
              lang={lang}
              hidden={{ lang, shop_id: shop.id, shop_slug: shop.slug }}
              labels={d as unknown as Record<string, string>}
              tlds={domains.prices.map((p) => p.tld)}
              samePrice={domains.settings.same_price_as_registrar}
              hasPlan={hasPlan}
              proPrice={proPrice && proPrice.cents !== null ? { ...proPrice, cents: proPrice.cents } : null}
              owner={
                domains.owner
                  ? { fields, missing: domains.owner.missing, company: domains.owner.company_name, ico: domains.owner.ico }
                  : null
              }
              initial={quote}
              termsHref={`/${lang}/podmienky`}
              domainTermsHref={`/${lang}/podmienky-domeny`}
              checkAction={checkDomain}
              saveLegalAction={saveLegal}
              payAction={payDomain}
            />

            <section id="own" className="flex flex-col gap-3 border-t border-line pt-4" aria-labelledby="own-heading">
              <h3 id="own-heading" className="font-semibold">
                {d.own_title}
              </h3>
              <p className="text-sm">{d.own_intro}</p>
              {hasPlan ? (
                <form action={connectDomain} className="flex flex-col gap-2" data-connect>
                  {hidden}
                  <label className="flex flex-col gap-1">
                    <span className="text-sm">{d.own_label}</span>
                    <input
                      name="domain"
                      required
                      maxLength={300}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder={d.step2_placeholder}
                      className="rounded border border-line px-3 py-2 outline-none focus:border-foreground"
                    />
                  </label>
                  <PendingButton pending={d.checking}>{d.own_button}</PendingButton>
                </form>
              ) : (
                <p className="text-sm text-muted">{d.own_needs_pro}</p>
              )}
            </section>
          </>
        )}

        {transferable && current && (
          <section id="transfer" className="flex flex-col gap-2 border-t border-line pt-4 text-sm" aria-labelledby="transfer-heading">
            <h3 id="transfer-heading" className="font-semibold">
              {d.auth_title}
            </h3>
            <p>{t(d.auth_text, { domain: current.hostname })}</p>
            {current.auth_code ? (
              <p className="font-mono font-semibold" data-auth-code>
                {t(d.auth_code, { code: current.auth_code })}
              </p>
            ) : (
              <form action={requestAuthCode}>
                {hidden}
                <input type="hidden" name="order_id" value={current.id} />
                <PendingButton pending={d.checking}>{d.auth_button}</PendingButton>
              </form>
            )}
          </section>
        )}
      </section>
    </div>
  );
}
