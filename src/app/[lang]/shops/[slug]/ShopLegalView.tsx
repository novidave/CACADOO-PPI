import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Locale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { siteLang, sitePath } from "@/lib/customDomain";
import { getShop, shopLegalPage, shopSiteHost } from "@/lib/data";
import { addressLine, formatDate } from "@/lib/format";
import { siteUrl } from "@/lib/site";

/** The page's address: on the shop's own domain "/pravne-informacie" (or "/hu/pravne-informacie"), else on Cacaduu. */
export function shopLegalPath(lang: string, slug: string, onSite: boolean, homeLang: string): string {
  if (!onSite) return `/${lang}/shops/${slug}/pravne-informacie`;
  return lang === homeLang ? "/pravne-informacie" : `/${lang}/pravne-informacie`;
}

async function load(slug: string, onSite: boolean) {
  const shop = await getShop(slug).catch(() => null);
  if (!shop) return null;
  const host = await shopSiteHost(shop.slug).catch(() => null);
  if (onSite && !host) return null;
  return { shop, host, homeLang: siteLang(shop.country, shop.site_lang) };
}

export async function shopLegalMetadata(lang: Locale, slug: string, onSite: boolean): Promise<Metadata> {
  const [dict, found] = await Promise.all([getDictionary(lang), load(slug, onSite)]);
  if (!found) return {};
  const { shop, host, homeLang } = found;
  // canonical: the live own domain when there is one
  const canonical = host
    ? `https://${host}${shopLegalPath(lang, slug, true, homeLang)}`
    : `${siteUrl()}${shopLegalPath(lang, slug, false, homeLang)}`;
  return { title: t(dict.shop_legal.title_of, { name: shop.name }), alternates: { canonical }, robots: { index: false, follow: true } };
}

/**
 * A shop's own "Právne informácie" (database update 65): who runs the shop (its company details), the e-mail for
 * questions about personal data, and the shop's own privacy notice, terms of sale and complaints procedure exactly as
 * the owner wrote them in Môj obchod (never edited or translated by PPI). The platform's own documents follow as links.
 */
export async function ShopLegalView({ lang, slug, onSite }: { lang: Locale; slug: string; onSite: boolean }) {
  const [dict, found, page] = await Promise.all([getDictionary(lang), load(slug, onSite), shopLegalPage(slug)]);
  if (!found || !page) notFound();
  const { shop, homeLang } = found;
  const l = dict.shop_legal;
  const shopHref = onSite ? sitePath(lang, homeLang) : `/${lang}/shops/${shop.slug}`;
  const cacaduu = (path: string) => (onSite ? `${siteUrl()}/${lang}${path}` : `/${lang}${path}`);
  const company = [page.company_name, page.ico ? `${l.ico} ${page.ico}` : null, page.dic ? `${l.dic} ${page.dic}` : null].filter(Boolean);
  const address = addressLine(page.address, [page.zip, page.city].filter(Boolean).join(" "));
  const sections: [string, string, string | null][] = [
    ["privacy", l.privacy_title, page.privacy],
    ["terms", l.terms_title, page.terms],
    ["complaints", l.complaints_title, page.complaints],
  ];
  const written = sections.filter(([, , text]) => text);

  return (
    <article className="mx-auto flex max-w-2xl flex-col gap-5" data-shop-legal>
      <Link href={shopHref} className="flex min-h-11 items-center self-start text-sm underline underline-offset-4">
        {t(l.back, { name: shop.name })}
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{l.title}</h1>

      <section className="flex flex-col gap-1 border-y border-line py-3" data-shop-operator>
        <h2 className="font-semibold">{l.operator_title}</h2>
        <p>{page.company_name ?? page.name}</p>
        {company.length > (page.company_name ? 1 : 0) && <p className="text-sm">{company.join(" · ")}</p>}
        {address && <p className="text-sm">{address}</p>}
        {page.contact_email && (
          <p className="text-sm">
            {l.contact}{" "}
            <a href={`mailto:${page.contact_email}`} className="break-all underline underline-offset-4">
              {page.contact_email}
            </a>
          </p>
        )}
      </section>

      {written.length === 0 && <p className="text-sm text-muted">{l.none_yet}</p>}
      {written.map(([id, title, text]) => (
        <section key={id} id={id} className="flex scroll-mt-4 flex-col gap-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          <div className="whitespace-pre-line break-words">{text}</div>
        </section>
      ))}
      {page.updated_at && written.length > 0 && <p className="text-xs text-muted">{t(l.updated, { date: formatDate(page.updated_at, lang, null) })}</p>}

      <section className="flex flex-col gap-1 border-t border-line pt-3 text-sm" data-platform>
        <h2 className="font-semibold">{l.platform_title}</h2>
        <p className="text-muted">{l.platform_intro}</p>
        <p className="flex flex-wrap gap-x-4">
          <a href={cacaduu("/sukromie-asistent")} className="flex min-h-11 items-center underline underline-offset-4">
            {dict.privacy_assistant.title}
          </a>
          <a href={cacaduu("/sukromie")} className="flex min-h-11 items-center underline underline-offset-4">
            {dict.privacy.title}
          </a>
        </p>
      </section>
    </article>
  );
}
