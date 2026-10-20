import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { callDomains, type DomainOrder, euros, type Findable, loadDomainPage, loadFindable, OPEN_STATUSES, OWNER_FIELDS, refusedFields } from "@/lib/domains";
import { recordName } from "@/lib/domainName";
import { formatDate, formatDateTime } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { CopyButton } from "@/components/CopyButton";
import { DbError } from "@/components/DbError";
import { DomainStatus, type DomainView } from "@/components/DomainStatus";
import { DomainWizard, type WizardCheck } from "@/components/DomainWizard";
import { PendingButton } from "@/components/PendingButton";
import { PlanDetails, type PlanRow } from "../PlanDetails";
import {
  cancelDomainPayment,
  checkDomain,
  connectDomain,
  disconnectDomain,
  payDomain,
  removeGoogle,
  requestAuthCode,
  saveCategories,
  saveLegal,
  saveVerificationMeta,
  verifyGoogle,
} from "./actions";

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
  // Search Console, Bing, llms.txt categories and IndexNow on a live domain (database updates 33 and 36).
  const findable = open?.status === "live" ? await loadFindable(supabase, open.id, shop.id).catch(() => null) : null;
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
    legal_ico: d.legal_ico,
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
            {refusedFields(open).length > 0 && (
              // Websupport refused some of the owner's details: corrected here, the registration goes on by itself.
              <section className="flex flex-col gap-3 border border-foreground p-4" data-owner-refused>
                <p className="font-semibold">{d.owner_refused_title}</p>
                <p className="text-sm">
                  {t(d.owner_refused_fields, {
                    fields: refusedFields(open).map((f) => (d as Record<string, unknown>)[`field_${f}`] as string).join(", "),
                  })}
                </p>
                <form action={saveLegal} className="flex flex-col gap-3">
                  {hidden}
                  <input type="hidden" name="retry_order" value={open.id} />
                  {fields.map((f) => (
                    <label key={f.name} className="flex flex-col gap-1 text-sm">
                      <span className={refusedFields(open).includes(f.name) ? "font-semibold" : undefined}>{f.label}</span>
                      <input
                        name={f.name}
                        defaultValue={f.value ?? ""}
                        maxLength={f.name === "country" ? 2 : 200}
                        className="rounded border border-line px-3 py-2 outline-none focus:border-foreground"
                      />
                    </label>
                  ))}
                  <PendingButton pending={d.checking}>{d.owner_refused_save}</PendingButton>
                </form>
              </section>
            )}
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
            {findable && (
              <FindableSection order={open} findable={findable} hidden={hidden} lang={lang} timeZone={shop.timezone} d={d} ok={ok} err={err} />
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

const SEARCH_CONSOLE_URL = "https://search.google.com/search-console";
const BING_WEBMASTER_URL = "https://www.bing.com/webmasters";

/** One DNS record to add by hand, each part with "Kopírovať". */
function RecordTable({ name, value, d }: { name: string; value: string; d: Dictionary["domains"] }) {
  const copy = { copy: d.dns_copy, copied: d.dns_copied };
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-line text-left text-muted">
          <th className="py-1 pr-3 font-normal">{d.dns_type}</th>
          <th className="py-1 pr-3 font-normal">{d.dns_name}</th>
          <th className="py-1 pr-3 font-normal">{d.dns_value}</th>
        </tr>
      </thead>
      <tbody>
        <tr className="border-b border-line align-top">
          <td className="py-1 pr-3 font-mono">TXT</td>
          <td className="py-1 pr-3">
            <span className="font-mono">{name}</span> <CopyButton text={name} labels={copy} />
          </td>
          <td className="py-1 pr-3">
            <span className="break-all font-mono">{value}</span> <CopyButton text={value} labels={copy} />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** Google's "HTML značka" or Bing's meta tag on the domain's pages (owner_set_site_verification, update 36). */
function MetaTagForm({
  kind,
  orderId,
  current,
  host,
  hidden,
  d,
  ok,
  err,
}: {
  kind: "google" | "bing";
  orderId: string;
  current: string | null;
  host: string;
  hidden: React.ReactNode;
  d: Dictionary["domains"];
  ok: string | undefined;
  err: string | undefined;
}) {
  const name = kind === "google" ? "google-site-verification" : "msvalidate.01";
  const tag = current ? `<meta name="${name}" content="${current}" />` : null;
  const notice = ({
    [`meta_${kind}_saved`]: t(kind === "google" ? d.meta_google_saved : d.meta_bing_saved, { domain: host }),
    [`meta_${kind}_removed`]: d.meta_removed,
  } as Record<string, string>)[ok ?? ""];
  return (
    <div className="flex flex-col gap-2" data-meta-form={kind}>
      <form action={saveVerificationMeta} className="flex flex-col gap-2">
        {hidden}
        <input type="hidden" name="order_id" value={orderId} />
        <input type="hidden" name="kind" value={kind} />
        <label className="flex flex-col gap-1">
          <span className="text-sm">{kind === "google" ? d.google_meta_label : d.bing_label}</span>
          <textarea
            name="value"
            required
            rows={2}
            maxLength={500}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={`<meta name="${name}" content="…" />`}
            className="rounded border border-line px-3 py-2 font-mono text-sm outline-none focus:border-foreground"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <PendingButton pending={d.checking}>{d.meta_button}</PendingButton>
        </div>
        <p className="text-xs text-muted">{t(d.meta_note, { domain: host })}</p>
      </form>
      {err === `meta_${kind}_invalid` && (
        <p role="alert" className="border border-line p-3 text-sm" data-meta-error>
          {kind === "google" ? d.meta_google_invalid : d.meta_bing_invalid}
        </p>
      )}
      {notice && (
        <p role="status" className="border border-foreground p-3 text-sm font-medium" data-meta-notice>
          {notice}
        </p>
      )}
      {tag && (
        <div className="flex flex-col gap-2 border border-line p-3 text-sm" data-meta-current>
          <p>{t(d.meta_current, { domain: host })}</p>
          <code className="break-all font-mono text-xs">{tag}</code>
          <form action={saveVerificationMeta}>
            {hidden}
            <input type="hidden" name="order_id" value={orderId} />
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="remove" value="1" />
            <PendingButton pending={d.checking}>{d.meta_remove}</PendingButton>
          </form>
        </div>
      )}
    </div>
  );
}

/**
 * "Aby vás našli Google a AI asistenti" (database updates 33 and 36), on a live domain:
 * "Overiť v Google Search Console" — a domain whose DNS Cacaduu runs (bought here, or an own domain
 * in our Websupport account) gets the TXT value added to its DNS (only added; "Odstrániť" removes
 * only that record); an own domain elsewhere gets a) the "HTML značka" on its pages (recommended,
 * property "Predpona webovej adresy") or b) the TXT record to add by hand. Bing Webmaster Tools: the
 * same meta tag method, or the import from Search Console. "Odoslať sitemap" for both, llms.txt and
 * robots.txt with the categories for llms.txt, and the last IndexNow ping.
 */
function FindableSection({
  order,
  findable,
  hidden,
  lang,
  timeZone,
  d,
  ok,
  err,
}: {
  order: DomainOrder;
  findable: Findable;
  hidden: React.ReactNode;
  lang: Locale;
  timeZone: string;
  d: Dictionary["domains"];
  /** The answer of the last action, shown next to its form (the page comes back at #findable). */
  ok: string | undefined;
  err: string | undefined;
}) {
  const host = order.site_host ?? order.hostname;
  const base = `https://${host}`;
  const prefix = `${base}/`;
  // Cacaduu writes the record when it runs the domain's DNS (a domain bought here, or one in our Websupport account).
  const auto = Boolean(order.registrar_service_id);
  const value = findable.google_verification;
  const state = findable.google_verification_state;
  const okResult = /^2\d\d$/.test(findable.indexnow_result ?? "");
  const copy = { copy: d.dns_copy, copied: d.dns_copied };
  const googleError = ({ google_invalid: d.google_invalid, google_too_many: d.google_too_many, google_too_soon: d.google_too_soon } as Record<string, string>)[err ?? ""];
  const removedNotice = ({ google_removed: d.google_removed, google_removed_dns: d.google_removed_dns } as Record<string, string>)[ok ?? ""];

  const txtForm = (
    <form action={verifyGoogle} className="flex flex-col gap-2" data-google-form>
      {hidden}
      <input type="hidden" name="order_id" value={order.id} />
      <label className="flex flex-col gap-1">
        <span className="text-sm">{d.google_label}</span>
        <input
          name="value"
          required
          maxLength={300}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          defaultValue={value ?? ""}
          placeholder="google-site-verification=…"
          className="rounded border border-line px-3 py-2 font-mono text-sm outline-none focus:border-foreground"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <PendingButton pending={d.checking}>{auto ? d.google_button_auto : d.google_button_manual}</PendingButton>
      </div>
      <p className="text-xs text-muted">{auto ? d.google_auto_note : d.google_manual_note}</p>
      {googleError && (
        <p role="alert" className="border border-line p-3 text-sm" data-google-error>
          {googleError}
        </p>
      )}
    </form>
  );
  const removeForm = value && (
    <form action={removeGoogle} className="flex flex-col gap-1" data-google-remove>
      {hidden}
      <input type="hidden" name="order_id" value={order.id} />
      <div>
        <PendingButton pending={d.checking}>{d.google_remove}</PendingButton>
      </div>
      <p className="text-xs text-muted">{state === "added" ? d.google_remove_note_added : d.google_remove_note_other}</p>
    </form>
  );
  const txtSteps = (
    <ol className="flex list-decimal flex-col gap-1 pl-6 text-sm">
      <li>
        {t(d.google_step1, { domain: host })}{" "}
        <a href={SEARCH_CONSOLE_URL} target="_blank" rel="noopener" className="underline underline-offset-4">
          {d.google_open}
        </a>
      </li>
      <li>{d.google_step2}</li>
      <li>{d.google_step3}</li>
    </ol>
  );
  const txtState = (
    <>
      {value && state === "added" && (
        <p role="status" className="border border-foreground p-3 text-sm font-medium" data-google-added>
          {t(d.google_added, { domain: host })}
        </p>
      )}
      {value && state === "present" && (
        <p role="status" className="border border-foreground p-3 text-sm font-medium" data-google-present>
          {t(d.google_present, { domain: host })}
        </p>
      )}
      {value && state === "manual" && (
        <div className="flex flex-col gap-2 border border-foreground p-3 text-sm" data-google-record>
          <p className="font-medium">{t(d.google_manual, { domain: host })}</p>
          <RecordTable name={recordName(host)} value={value} d={d} />
          <p className="font-semibold">{d.google_manual_keep}</p>
        </div>
      )}
      {removedNotice && (
        <p role="status" className="border border-foreground p-3 text-sm font-medium" data-google-removed>
          {removedNotice}
        </p>
      )}
      {removeForm}
    </>
  );

  return (
    <section id="findable" className="flex flex-col gap-4 border-t border-line pt-4" aria-labelledby="findable-heading" data-findable>
      <h3 id="findable-heading" className="font-semibold">
        {d.findable_title}
      </h3>
      <p className="text-sm text-muted">{t(d.findable_intro, { domain: host })}</p>

      <div id="verify-google" className="flex flex-col gap-3 border border-line p-4" data-google>
        <h4 className="font-semibold">{d.google_title}</h4>
        {auto ? (
          <>
            {txtSteps}
            {txtForm}
            {txtState}
          </>
        ) : (
          <>
            <div className="flex flex-col gap-2" data-google-meta>
              <h5 className="text-sm font-semibold">{d.google_meta_title}</h5>
              <ol className="flex list-decimal flex-col gap-1 pl-6 text-sm">
                <li>
                  {t(d.google_meta_step1, { url: prefix })}{" "}
                  <a href={SEARCH_CONSOLE_URL} target="_blank" rel="noopener" className="underline underline-offset-4">
                    {d.google_open}
                  </a>
                </li>
                <li>{d.google_meta_step2}</li>
                <li>{d.google_meta_step3}</li>
              </ol>
              <MetaTagForm kind="google" orderId={order.id} current={findable.google_meta} host={host} hidden={hidden} d={d} ok={ok} err={err} />
            </div>
            <div className="flex flex-col gap-2 border-t border-line pt-3" data-google-txt>
              <h5 className="text-sm font-semibold">{d.google_txt_title}</h5>
              <p className="text-sm">{d.google_txt_text}</p>
              {txtSteps}
              {txtForm}
              {txtState}
            </div>
          </>
        )}
      </div>

      <div id="verify-bing" className="flex flex-col gap-3 border border-line p-4" data-bing>
        <h4 className="font-semibold">{d.bing_title}</h4>
        <p className="text-sm">{d.bing_import}</p>
        <ol className="flex list-decimal flex-col gap-1 pl-6 text-sm">
          <li>
            {t(d.bing_step1, { url: prefix })}{" "}
            <a href={BING_WEBMASTER_URL} target="_blank" rel="noopener" className="underline underline-offset-4">
              {d.bing_open}
            </a>
          </li>
          <li>{d.bing_step2}</li>
          <li>{d.bing_step3}</li>
        </ol>
        <MetaTagForm kind="bing" orderId={order.id} current={findable.bing_meta} host={host} hidden={hidden} d={d} ok={ok} err={err} />
      </div>

      <div className="flex flex-col gap-2 border border-line p-4" data-sitemap>
        <h4 className="break-all font-semibold">{t(d.sitemap_title, { url: `${base}/sitemap.xml` })}</h4>
        <p className="flex flex-wrap items-center gap-3 text-sm">
          <a href={`${base}/sitemap.xml`} target="_blank" rel="noopener" className="break-all font-mono underline underline-offset-4">
            {base}/sitemap.xml
          </a>
          <CopyButton text={`${base}/sitemap.xml`} labels={copy} />
        </p>
        <h5 className="text-sm font-semibold">{d.sitemap_google}</h5>
        <ol className="flex list-decimal flex-col gap-1 pl-6 text-sm">
          <li>{d.sitemap_step1}</li>
          <li>{d.sitemap_step2}</li>
          <li>{d.sitemap_step3}</li>
        </ol>
        <h5 className="text-sm font-semibold">{d.sitemap_bing}</h5>
        <ol className="flex list-decimal flex-col gap-1 pl-6 text-sm" data-sitemap-bing>
          <li>{d.sitemap_bing_step1}</li>
          <li>{t(d.sitemap_bing_step2, { url: `${base}/sitemap.xml` })}</li>
        </ol>
      </div>

      <div className="flex flex-col gap-2 border border-line p-4" data-ai-files>
        <h4 className="font-semibold">{d.ai_title}</h4>
        <p className="text-sm">{d.ai_text}</p>
        <p className="flex flex-wrap gap-x-4 text-sm">
          <a href={`${base}/llms.txt`} target="_blank" rel="noopener" className="font-mono underline underline-offset-4">
            llms.txt
          </a>
          <a href={`${base}/robots.txt`} target="_blank" rel="noopener" className="font-mono underline underline-offset-4">
            robots.txt
          </a>
        </p>
        <form action={saveCategories} className="flex flex-col gap-2" data-categories>
          {hidden}
          <label className="flex flex-col gap-1">
            <span className="text-sm">{d.categories_label}</span>
            <textarea
              name="categories"
              rows={2}
              maxLength={1000}
              defaultValue={findable.categories.join(", ")}
              className="rounded border border-line px-3 py-2 text-sm outline-none focus:border-foreground"
            />
          </label>
          <p className="text-xs text-muted">{d.categories_hint}</p>
          <PendingButton pending={d.checking}>{d.categories_button}</PendingButton>
          {ok === "categories" && (
            <p role="status" className="border border-foreground p-3 text-sm font-medium" data-categories-notice>
              {d.categories_saved}
            </p>
          )}
          {err === "categories" && (
            <p role="alert" className="border border-line p-3 text-sm" data-categories-notice>
              {d.categories_error}
            </p>
          )}
        </form>
      </div>

      <div className="flex flex-col gap-1 border border-line p-4 text-sm" data-indexnow>
        <h4 className="font-semibold">{d.indexnow_title}</h4>
        <p>{d.indexnow_text}</p>
        <p className="text-muted" data-indexnow-last>
          {!findable.indexnow_at
            ? d.indexnow_none
            : okResult
              ? t(d.indexnow_last, { time: formatDateTime(findable.indexnow_at, lang, timeZone), n: String(findable.indexnow_urls ?? 0) })
              : t(d.indexnow_failed, { time: formatDateTime(findable.indexnow_at, lang, timeZone), result: findable.indexnow_result ?? "" })}
        </p>
      </div>
    </section>
  );
}
