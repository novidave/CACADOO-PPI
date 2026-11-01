import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import type { MyShop } from "@/lib/myShops";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { hiddenFields, inputClass, ShopSwitcher } from "../shared";
import { saveLegalPage } from "./actions";

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
  const hidden = hiddenFields(lang, shop);
  const texts = l as Record<string, string>;
  const ok = first(sp.ok);
  const err = first(sp.err);
  const view = `/${lang}/shops/${shop.slug}/pravne-informacie`;
  const field = (name: "privacy" | "terms" | "complaints", label: string, hint: string) => (
    <label className="flex flex-col gap-1">
      <span className="font-semibold">{label}</span>
      <span className="text-sm text-muted">{hint}</span>
      <textarea name={name} rows={10} maxLength={30000} defaultValue={row?.[name] ?? ""} className={`${inputClass} text-[15px]`} />
    </label>
  );

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{l.admin_title}</h1>
        <ShopSwitcher shops={shops} current={shop} label={dict.dashboard.shop} href={(slug) => `/${lang}/dashboard/legal?shop=${slug}`} />
        {shops.length > 1 && <p className="text-muted">{shop.name}</p>}
        <p className="text-sm">{l.admin_intro}</p>
        <Link href={view} className="flex min-h-11 items-center self-start text-sm underline underline-offset-4">
          {l.admin_view}
        </Link>
      </header>
      {ok && <p role="status" className="border border-foreground p-3 font-medium">{l.saved}</p>}
      {err && <p role="alert" className="border border-line p-3">{texts[err] ?? l.err_failed}</p>}
      {error && <p className="border border-line p-3 text-sm">{l.unavailable}</p>}

      <section className="flex flex-col gap-1 rounded-xl border border-line p-4 text-sm" data-legal-company>
        <h2 className="text-[17px] font-bold">{l.operator_title}</h2>
        <p className="text-muted">{l.admin_company_hint}</p>
        <Link href={`/${lang}/dashboard?${new URLSearchParams({ shop: shop.slug })}`} className="flex min-h-11 items-center self-start underline underline-offset-4">
          {l.admin_company_link}
        </Link>
      </section>

      <form action={saveLegalPage} className="flex flex-col gap-4" data-legal-form>
        {hidden()}
        <label className="flex flex-col gap-1">
          <span className="font-semibold">{l.admin_email}</span>
          <span className="text-sm text-muted">{l.admin_email_hint}</span>
          <input type="email" name="contact_email" maxLength={254} defaultValue={row?.contact_email ?? ""} placeholder={shop.email ?? ""} className={inputClass} />
        </label>
        {field("privacy", l.privacy_title, l.admin_privacy_hint)}
        {field("terms", l.terms_title, l.admin_terms_hint)}
        {field("complaints", l.complaints_title, l.admin_complaints_hint)}
        <p className="text-sm text-muted">{l.admin_as_written}</p>
        <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>
      </form>
    </div>
  );
}
