import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { siteLang, sitePath } from "@/lib/customDomain";
import { getShop } from "@/lib/data";
import { getSiteLogo } from "@/lib/sections";
import { type SiteVerification, verificationMetadata } from "@/lib/siteFiles";
import { createPublicClient } from "@/lib/supabase/public";
import { SiteLanguageSwitch } from "@/components/LanguageSwitch";
import { quicksand } from "../../../fonts";
import "../../../globals.css";

/**
 * The layout of a shop's own domain (database update 25): no Cacadoo header. The shop's own
 * header, as before update 28: a small logo at the top left that leads to the shop's home page
 * (its header logo, database update 31; else the shop's logo; else its name), or to the address
 * the owner chose for it ("Odkaz loga", database update 32; same window), and the SK · HU · EN
 * switch on the right, a thin line under it. The shop's name and logo are also on the page itself,
 * above its details. Only src/proxy.ts sends visitors here (the page and its items).
 */
export async function generateMetadata({ params }: LayoutProps<"/site/[lang]/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const supabase = createPublicClient();
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
  const homeLang = siteLang(shop.country);
  const siteLogo = await getSiteLogo(slug).catch(() => null);
  const logo = siteLogo?.url ?? shop.logo_url;
  const own = Boolean(siteLogo?.url);
  // The database checked the address (https of a real host); without one, the home page.
  const link = siteLogo?.link?.startsWith("https://") ? siteLogo.link : null;
  const content = logo ? (
    // eslint-disable-next-line @next/next/no-img-element -- the shop's own small logo from Supabase Storage
    <img
      src={logo}
      alt={shop.name}
      width={own ? (siteLogo?.width ?? undefined) : undefined}
      height={own ? (siteLogo?.height ?? undefined) : undefined}
      className="h-9 w-auto max-w-[200px] object-contain sm:h-10"
      data-site-logo={own ? "own" : "shop"}
    />
  ) : (
    <span className="truncate text-lg font-semibold tracking-tight">{shop.name}</span>
  );
  const linkClass = "flex h-9 min-w-0 items-center overflow-hidden whitespace-nowrap sm:h-10";

  return (
    <html lang={lang} className={`${quicksand.variable} h-full antialiased`}>
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
            <SiteLanguageSwitch current={lang} homeLang={homeLang} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
