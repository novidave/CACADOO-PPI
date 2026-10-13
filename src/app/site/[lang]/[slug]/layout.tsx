import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { siteLang, sitePath } from "@/lib/customDomain";
import { getShop } from "@/lib/data";
import { getSiteLogo } from "@/lib/sections";
import { SiteLanguageSwitch } from "@/components/LanguageSwitch";
import "../../../globals.css";

/**
 * The layout of a shop's own domain (database update 25): no Cacadoo header. The shop's own
 * header, as before update 28: a small logo at the top left that leads to the shop's home page
 * (its header logo, database update 31; else the shop's logo; else its name) and the SK · HU · EN
 * switch on the right, a thin line under it. The shop's name and logo are also on the page itself,
 * above its details. Only src/proxy.ts sends visitors here (the page and its items).
 */
export async function generateMetadata({ params }: LayoutProps<"/site/[lang]/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const shop = await getShop(slug).catch(() => null);
  return shop ? { title: { default: shop.name, template: "%s" } } : {};
}

export default async function SiteLayout({ children, params }: LayoutProps<"/site/[lang]/[slug]">) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const shop = await getShop(slug);
  if (!shop) notFound();
  const homeLang = siteLang(shop.country);
  const siteLogo = await getSiteLogo(slug).catch(() => null);
  const logo = siteLogo?.url ?? shop.logo_url;

  return (
    <html lang={lang} className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-white text-foreground">
        <header className="border-b border-line" data-site-header>
          <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3">
            <Link
              href={sitePath(lang, homeLang)}
              className="flex h-9 min-w-0 items-center overflow-hidden whitespace-nowrap sm:h-10"
              aria-label={shop.name}
              data-site-home
            >
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- the shop's own small logo from Supabase Storage
                <img
                  src={logo}
                  alt={shop.name}
                  width={siteLogo?.width}
                  height={siteLogo?.height}
                  className="h-9 w-auto max-w-[200px] object-contain sm:h-10"
                  data-site-logo={siteLogo ? "own" : "shop"}
                />
              ) : (
                <span className="truncate text-lg font-semibold tracking-tight">{shop.name}</span>
              )}
            </Link>
            <SiteLanguageSwitch current={lang} homeLang={homeLang} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
