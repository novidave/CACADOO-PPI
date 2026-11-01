import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, enabledLocales } from "@/i18n/dictionaries";
import { languageOf } from "@/i18n/languages";
import { sitePath } from "@/lib/customDomain";
import { getShop } from "@/lib/data";
import { getShopLanguages } from "@/lib/shopLanguages";
import { getSiteLogo } from "@/lib/sections";
import { type SiteVerification, verificationMetadata } from "@/lib/siteFiles";
import { createCachedPublicClient } from "@/lib/supabase/public";
import { LanguagePicker } from "@/components/LanguagePicker";
import { notoFallback, quicksand } from "../../../fonts";
import { VercelMetrics } from "@/components/VercelMetrics";
import "../../../globals.css";

/**
 * The layout of a shop's own domain (database update 25): no Cacaduu header. The shop's own
 * header, as before update 28: a small logo at the top left that leads to the shop's home page
 * (its header logo, database update 31; else the shop's logo; else its name), or to the address
 * the owner chose for it ("Odkaz loga", database update 32; same window), and the language picker (update 40:
 * "Odporúčané" = the shop's preferred languages; "/" = its "Predvolený jazyk na vlastnej doméne") on the right, a thin line under it. The shop's name and logo are also on the page itself,
 * above its details. Only src/proxy.ts sends visitors here (the page and its items).
 */
export async function generateMetadata({ params }: LayoutProps<"/site/[lang]/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const supabase = createCachedPublicClient();
  const [shop, meta, host] = await Promise.all([
    getShop(slug).catch(() => null),
    // The owner's Google ("HTML značka") and Bing meta tags (update 36; nothing before it).
    supabase
      ? Promise.resolve(supabase.rpc("site_verification_meta", { p_slug: slug })).then(({ data }) => (data as SiteVerification | null) ?? null, () => null)
      : Promise.resolve(null),
    headers().then((h) => h.get("host")),
  ]);
  if (!shop) return {};
  const verification = verificationMetadata(meta, host);
  return { title: { default: shop.name, template: "%s" }, ...(verification ? { verification } : {}) };
}

export default async function SiteLayout({ children, params }: LayoutProps<"/site/[lang]/[slug]">) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const shop = await getShop(slug);
  if (!shop) notFound();
  const [langs, enabled, dict, siteLogo] = await Promise.all([
    getShopLanguages(slug, shop.country),
    enabledLocales(),
    getDictionary(lang),
    getSiteLogo(slug).catch(() => null),
  ]);
  if (!enabled.includes(lang)) notFound();
  const homeLang = langs.home;
  const logo = siteLogo?.url ?? shop.logo_url;
  const own = Boolean(siteLogo?.url);
  // The database checked the address (https of a real host); without one, the home page.
  const link = siteLogo?.link?.startsWith("https://") ? siteLogo.link : null;
  // The shop's own header logo as it is (it often holds the name); else the shop's logo at 32 px with its name
  // (Screen 11); else the name.
  const content = own && logo ? (
    // eslint-disable-next-line @next/next/no-img-element -- the shop's own small logo from Supabase Storage
    <img
      src={logo}
      alt={shop.name}
      width={siteLogo?.width ?? undefined}
      height={siteLogo?.height ?? undefined}
      className="h-8 w-auto max-w-[200px] object-contain sm:h-10"
      data-site-logo="own"
    />
  ) : logo ? (
    <span className="flex min-w-0 items-center gap-1.5">
      {/* eslint-disable-next-line @next/next/no-img-element -- the shop's logo from Supabase Storage */}
      <img src={logo} alt="" width={32} height={32} className="h-8 w-8 shrink-0 object-contain" data-site-logo="shop" />
      <span className="truncate text-lg font-bold tracking-tight">{shop.name}</span>
    </span>
  ) : (
    <span className="truncate text-lg font-semibold tracking-tight">{shop.name}</span>
  );
  const linkClass = "flex h-9 min-w-0 items-center overflow-hidden whitespace-nowrap sm:h-10";

  return (
    <html lang={lang} dir="ltr" data-script={languageOf(lang)?.script} className={`${quicksand.variable} ${notoFallback.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-white text-foreground">
        <header className="border-b border-line" data-site-header>
          <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3">
            {link ? (
              <a href={link} rel="noopener" className={linkClass} aria-label={shop.name} data-site-home="link">
                {content}
              </a>
            ) : (
              <Link href={sitePath(lang, homeLang)} className={linkClass} aria-label={shop.name} data-site-home="home">
                {content}
              </Link>
            )}
            <LanguagePicker
              current={lang}
              currentNative={languageOf(lang)?.native ?? lang}
              enabled={enabled}
              recommended={[...new Set([langs.main, homeLang, ...langs.preferred])]}
              labels={dict.languages}
              site={{ homeLang }}
            />
          </div>
        </header>
        {/* At least one screen high: the footer starts below the first view, so nothing that grows moves it on screen. */}
        <main className="mx-auto min-h-svh w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
        {/* The shop's own legal page (update 65) and © with the shop's name. */}
        <footer className="mt-8 border-t border-line" data-site-footer>
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-5 px-4 py-3 text-sm text-muted">
            <Link href={lang === homeLang ? "/pravne-informacie" : `/${lang}/pravne-informacie`} className="flex min-h-11 items-center hover:text-foreground hover:underline">
              {dict.shop_legal.link}
            </Link>
            <span className="flex min-h-11 items-center sm:ml-auto">
              © {new Date().getFullYear()} {shop.name}
            </span>
          </div>
        </footer>
        {/* Cookie-free, only on Vercel (elsewhere their scripts do not exist); loaded after the page (privacy page). */}
        {process.env.VERCEL && <VercelMetrics />}
      </body>
    </html>
  );
}
