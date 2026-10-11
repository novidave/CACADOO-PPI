"use client";

import { useActionState, useState } from "react";
import { cleanDomain } from "@/lib/domainName";
import { PendingButton } from "./PendingButton";

type Labels = Record<string, string>;

export interface WizardCheck {
  state: "idle" | "available" | "taken" | "unsupported" | "invalid" | "has_domain" | "in_use" | "error" | "not_configured";
  domain?: string;
  problem?: string;
  order_id?: string;
  price_cents?: number;
  renewal_cents?: number;
  vat_included?: boolean;
  test?: boolean;
}

interface OwnerField {
  name: string;
  label: string;
  required: boolean;
  value: string | null;
}

const fmt = (lang: string, cents: number, currency = "EUR") =>
  new Intl.NumberFormat(lang, { style: "currency", currency }).format(cents / 100);

/**
 * Steps 2–4 of "Kúpiť doménu": the pasted name (cleaned as typed, checked by the function),
 * the owner's missing details, and the payment. The price shown is the price charged: it
 * comes from the checked order, whose price was frozen when it was shown.
 */
export function DomainWizard({
  lang,
  hidden,
  labels,
  tlds,
  samePrice,
  hasPlan,
  proPrice,
  owner,
  initial,
  termsHref,
  domainTermsHref,
  checkAction,
  saveLegalAction,
  payAction,
}: {
  lang: string;
  hidden: { lang: string; shop_id: string; shop_slug: string };
  labels: Labels;
  tlds: string[];
  samePrice: boolean;
  hasPlan: boolean;
  proPrice: { cents: number; currency: string; interval: string | null; interval_count: number } | null;
  owner: { fields: OwnerField[]; missing: string[]; company: string | null; ico: string | null } | null;
  initial: WizardCheck | null;
  termsHref: string;
  domainTermsHref: string;
  checkAction: (previous: WizardCheck, formData: FormData) => Promise<WizardCheck>;
  saveLegalAction: (formData: FormData) => Promise<void>;
  payAction: (formData: FormData) => Promise<void>;
}) {
  const idle: WizardCheck = { state: "idle" };
  const [result, check, checking] = useActionState<WizardCheck, FormData>(checkAction, initial ?? idle);
  const [typed, setTyped] = useState(initial?.domain ?? "");
  const cleaned = cleanDomain(typed);
  const hiddenInputs = (
    <>
      <input type="hidden" name="lang" value={hidden.lang} />
      <input type="hidden" name="shop_id" value={hidden.shop_id} />
      <input type="hidden" name="shop_slug" value={hidden.shop_slug} />
    </>
  );
  const vat = (included: boolean | undefined) => (included === false ? labels.vat_excluded : labels.vat_included);
  const proText = proPrice ? `${fmt(lang, proPrice.cents, proPrice.currency)}${proPrice.interval ? ` / ${proPrice.interval === "month" ? labels.month : proPrice.interval === "year" ? labels.year : proPrice.interval}` : ""}` : "";
  const available = result.state === "available" && result.order_id;
  const total = available ? (result.price_cents ?? 0) + (!hasPlan && proPrice ? proPrice.cents : 0) : 0;
  const missing = owner?.missing ?? [];

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-labelledby="step2">
        <h3 id="step2" className="font-semibold">
          {labels.step2_title}
        </h3>
        <form action={check} className="flex flex-col gap-2" data-domain-check>
          {hiddenInputs}
          <label className="flex flex-col gap-1">
            <span className="text-sm">{labels.step2_label}</span>
            <input
              name="domain"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={labels.step2_placeholder}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={300}
              required
              className="rounded border border-line px-3 py-2 outline-none focus:border-foreground"
            />
          </label>
          {cleaned && cleaned !== typed.trim() && (
            <p className="text-sm text-muted" data-cleaned>
              {labels.step2_cleaned.replace("{domain}", cleaned)}
            </p>
          )}
          {tlds.length > 0 && <p className="text-xs text-muted">{labels.tlds.replace("{list}", tlds.map((t) => `.${t}`).join(", "))}</p>}
          <button type="submit" disabled={checking} className="self-start rounded border border-foreground px-4 py-2 font-medium disabled:text-muted">
            {checking ? labels.step2_checking : labels.step2_button}
          </button>
        </form>
        <div role="status" aria-live="polite" data-check-result={result.state}>
          {result.state === "available" && (
            <div className="flex flex-col gap-1">
              <p className="font-semibold">
                {labels.available
                  .replace("{domain}", result.domain ?? "")
                  .replace("{price}", fmt(lang, result.price_cents ?? 0))
                  .replace("{vat}", vat(result.vat_included))}{" "}
                <span className="font-normal text-muted">{labels.available_note}</span>
              </p>
              {samePrice && (
                <p className="text-sm" data-same-price>
                  {labels.same_price}
                </p>
              )}
              {!hasPlan && proPrice && <p className="text-sm">{labels.pro_needed.replace("{price}", proText)}</p>}
              {result.test && <p className="text-sm text-muted">{labels.test_mode}</p>}
            </div>
          )}
          {result.state === "taken" && <p className="font-semibold">{labels.taken}</p>}
          {result.state === "unsupported" && <p className="font-semibold">{labels.unsupported}</p>}
          {result.state === "invalid" && <p className="font-semibold">{result.problem === "accents" ? labels.accents : labels.invalid}</p>}
          {result.state === "has_domain" && <p>{labels.has_domain}</p>}
          {result.state === "in_use" && <p>{labels.in_use}</p>}
          {result.state === "error" && <p>{labels.check_failed}</p>}
          {result.state === "not_configured" && <p>{labels.not_configured}</p>}
        </div>
      </section>

      {available && (
        <section className="flex flex-col gap-3" aria-labelledby="step3" data-step3>
          <h3 id="step3" className="font-semibold">
            {labels.step3_title}
          </h3>
          {missing.length > 0 ? (
            <form action={saveLegalAction} className="flex flex-col gap-3" data-owner-missing>
              {hiddenInputs}
              <p className="text-sm">{labels.step3_intro}</p>
              {(owner?.fields ?? [])
                .filter((f) => missing.includes(f.name) || (!f.required && !f.value))
                .map((f) => (
                  <label key={f.name} className="flex flex-col gap-1">
                    <span className="text-sm">{f.label}</span>
                    <input
                      name={f.name}
                      required={f.required}
                      maxLength={f.name === "country" ? 2 : 200}
                      className="rounded border border-line px-3 py-2 outline-none focus:border-foreground"
                    />
                  </label>
                ))}
              <PendingButton pending={labels.paying}>{labels.step3_save}</PendingButton>
            </form>
          ) : (
            <div className="flex flex-col gap-2 text-sm">
              <p data-owner-ok>{labels.step3_ok.replace("{company}", owner?.company ?? "").replace("{ico}", owner?.ico ?? "")}</p>
              <details>
                <summary className="cursor-pointer underline underline-offset-4">{labels.step3_edit}</summary>
                <form action={saveLegalAction} className="mt-2 flex flex-col gap-3">
                  {hiddenInputs}
                  {(owner?.fields ?? []).map((f) => (
                    <label key={f.name} className="flex flex-col gap-1">
                      <span>{f.label}</span>
                      <input
                        name={f.name}
                        defaultValue={f.value ?? ""}
                        maxLength={f.name === "country" ? 2 : 200}
                        className="rounded border border-line px-3 py-2 outline-none focus:border-foreground"
                      />
                    </label>
                  ))}
                  <PendingButton pending={labels.paying}>{labels.step3_save}</PendingButton>
                </form>
              </details>
            </div>
          )}
        </section>
      )}

      {available && (
        <section className="flex flex-col gap-3" aria-labelledby="step4" data-step4>
          <h3 id="step4" className="font-semibold">
            {labels.step4_title}
          </h3>
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-y border-line py-2 text-sm">
            <dt>{labels.line_domain.replace("{domain}", result.domain ?? "")}</dt>
            <dd className="text-right" data-line-domain>
              {labels.line_domain_price.replace("{price}", fmt(lang, result.price_cents ?? 0)).replace("{vat}", vat(result.vat_included))}
            </dd>
            {!hasPlan && proPrice && (
              <>
                <dt>{labels.line_pro}</dt>
                <dd className="text-right">{proText}</dd>
              </>
            )}
          </dl>
          <p className="font-semibold" data-total>
            {!hasPlan && proPrice
              ? labels.line_total.replace("{price}", fmt(lang, total))
              : `${labels.line_domain.replace("{domain}", result.domain ?? "")}: ${fmt(lang, result.price_cents ?? 0)} / ${labels.year} (${vat(result.vat_included)})`}
          </p>
          <form action={payAction} className="flex flex-col gap-3" data-pay>
            {hiddenInputs}
            <input type="hidden" name="order_id" value={result.order_id} />
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="accept_terms" required className="mt-1" />
              <span>
                {labels.terms_before}
                <a href={termsHref} target="_blank" rel="noopener" className="underline underline-offset-4">
                  {labels.terms_link}
                </a>
                {labels.terms_and}
                <a href={domainTermsHref} target="_blank" rel="noopener" className="underline underline-offset-4">
                  {labels.domain_terms_link}
                </a>
              </span>
            </label>
            {missing.length > 0 && <p className="text-sm">{labels.pay_owner_needed}</p>}
            {missing.length === 0 && <PendingButton pending={labels.paying}>{labels.pay.replace("{price}", fmt(lang, total))}</PendingButton>}
          </form>
        </section>
      )}
    </div>
  );
}
