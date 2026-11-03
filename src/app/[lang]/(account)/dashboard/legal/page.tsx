import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import type { MyShop } from "@/lib/myShops";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { SaveBar } from "@/components/owner/SaveBar";
import { cardClass, textareaClass } from "@/components/owner/ui";
import { hiddenFields, inputClass, saveLabels, ShopSwitcher } from "../shared";
import { OWNER_FIELDS } from "@/lib/domains";
import { saveCompany, saveLegalPage, saveOperator } from "./actions";
import { PageTitle } from "@/components/owner/PageHead";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/legal">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).shop_legal.admin_title };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

interface LegalRow {
  contact_email: string | null;
  privacy: string | null;
  terms: string | null;
  complaints: string | null;
  updated_at: string;
}

/**
 * Môj obchod → "Právne informácie" (database update 65; every shop): the owner writes the shop's own legal page —
 * the e-mail for questions about personal data, the privacy notice, the terms of sale and the complaints procedure.
 * Shown on the shop's own domain (/pravne-informacie) and on its Cacaduu address exactly as written; the company
 * details come from "Údaje obchodu". PPI never writes or changes these texts.
 */
export default async function LegalAdminPage({ params, searchParams }: PageProps<"/[lang]/dashboard/legal">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const l = dict.shop_legal;
  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];
  const { data, error } = await supabase
    .from("shop_legal_pages")
    .select("contact_email, privacy, terms, complaints, updated_at")
    .eq("shop_id", shop.id)
    .maybeSingle<LegalRow>();
  const row = error ? null : data;
  // the details a domain is registered with (update 25; owners only)
  const operatorRes = await supabase.rpc("domain_owner_details", { p_shop_id: shop.id });
  const operator = (operatorRes.error ? null : operatorRes.data) as Record<string, string | null> | null;
  const domainTexts = dict.domains as Record<string, unknown>;
  const hidden = hiddenFields(lang, shop);
  const texts = l as Record<string, string>;
  const ok = first(sp.ok);
  const err = first(sp.err);
  const view = `/${lang}/shops/${shop.slug}/pravne-informacie`;
  const field = (name: "privacy" | "terms" | "complaints", label: string, hint: string) => (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold">{label}</span>
      <span className="text-[13px] text-muted">{hint}</span>
      <textarea name={name} rows={10} maxLength={30000} defaultValue={row?.[name] ?? ""} className={`${textareaClass} text-[15px]`} />
    </label>
  );

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-2">
        <PageTitle>{l.admin_title}</PageTitle>
        <ShopSwitcher shops={shops} current={shop} label={dict.dashboard.shop} href={(slug) => `/${lang}/dashboard/legal?shop=${slug}`} />
        {shops.length > 1 && <p className="text-muted">{shop.name}</p>}
        <p className="text-sm">{l.admin_intro}</p>
        <Link href={view} className="flex min-h-11 items-center self-start text-sm underline underline-offset-4">
          {l.admin_view}
        </Link>
      </header>
      {ok && (
        <p role="status" className="border border-foreground p-3 font-medium">
          {ok === "company" ? l.company_saved : ok === "operator" ? l.operator_saved : l.saved}
        </p>
      )}
      {err && <p role="alert" className="border border-line p-3">{texts[err] ?? l.err_failed}</p>}
      {error && <p className="border border-line p-3 text-sm">{l.unavailable}</p>}

      {/* artboard 16: the company and the operator on the left, the texts for the customers on the right */}
      <div className="grid gap-[18px] lg:grid-cols-2 lg:items-start">
      <div className="flex min-w-0 flex-col gap-[18px]">
      {/* Firma (back-end layout L2: moved here from Údaje obchodu) */}
      <section id="company" className={`${cardClass} scroll-mt-4`} data-legal-company>
        <h2 className="text-[19px] font-bold">{l.company_form_title}</h2>
        <p className="text-sm text-muted">{l.company_form_hint}</p>
        <form action={saveCompany} className="flex flex-col gap-3">
          {hidden()}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold">{dict.owner.company_name}</span>
            <input name="company_name" maxLength={200} autoComplete="organization" defaultValue={shop.company_name ?? ""} className={inputClass} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold">{dict.owner.ico}</span>
              <input name="ico" maxLength={40} defaultValue={shop.ico ?? ""} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold">{dict.owner.dic}</span>
              <input name="dic" maxLength={20} defaultValue={shop.dic ?? ""} className={inputClass} />
            </label>
          </div>
          <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>
        </form>
      </section>

      {/* Údaje pre vlastnú doménu (shop_legal, update 25; the domain wizard asks for the missing ones too) */}
      {operator && (
        <section id="operator" className={`${cardClass} scroll-mt-4`} data-legal-operator>
          <h2 className="text-[19px] font-bold">{l.domain_owner_title}</h2>
          <p className="text-sm text-muted">{l.domain_owner_hint}</p>
          <form action={saveOperator} className="grid gap-3 sm:grid-cols-2">
            {hidden()}
            {OWNER_FIELDS.map((name) => (
              <label key={name} className={`flex flex-col gap-1.5 ${name === "company_name" || name === "street" ? "sm:col-span-2" : ""}`}>
                <span className="text-sm font-semibold">{domainTexts[`field_${name}`] as string}</span>
                <input name={name} maxLength={name === "country" ? 2 : 200} defaultValue={operator[name] ?? ""} className={inputClass} />
              </label>
            ))}
            <div className="sm:col-span-2">
              <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>
            </div>
          </form>
        </section>
      )}

      </div>

      <form action={saveLegalPage} className={`${cardClass} min-w-0`} data-legal-form>
        {hidden()}
        <h2 className="text-[19px] font-bold">{l.texts_title}</h2>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">{l.admin_email}</span>
          <span className="text-[13px] text-muted">{l.admin_email_hint}</span>
          <input type="email" name="contact_email" maxLength={254} defaultValue={row?.contact_email ?? ""} placeholder={shop.email ?? ""} className={inputClass} />
        </label>
        {field("privacy", l.privacy_title, l.admin_privacy_hint)}
        {field("terms", l.terms_title, l.admin_terms_hint)}
        {field("complaints", l.complaints_title, l.admin_complaints_hint)}
        <p className="text-sm text-muted">{l.admin_as_written}</p>
        <SaveBar labels={saveLabels(dict)} />
      </form>
      </div>
    </div>
  );
}
