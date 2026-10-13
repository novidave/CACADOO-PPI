import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { siteLang, sitePath } from "@/lib/customDomain";
import { getShop } from "@/lib/data";
import { SiteLanguageSwitch } from "@/components/LanguageSwitch";
import "../../../globals.css";

/**
 * The layout of a shop's own domain (database update 25): no Cacadoo header — the top shows
 * only the shop's name (and its logo) and the SK · HU · EN switch. Only src/proxy.ts sends
 * visitors here (the page and its items).
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

  return (
    <html lang={lang} className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-white text-foreground">
        <header className="border-b border-line" data-site-header>
          <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3">
            <Link href={sitePath(lang, homeLang)} className="flex min-w-0 items-center gap-3">
              {shop.logo_url && (
                // eslint-disable-next-line @next/next/no-img-element -- logos come from Supabase Storage
                <img src={shop.logo_url} alt="" width={40} height={40} className="h-10 w-10 shrink-0 border border-line object-contain" />
              )}
              <span className="truncate text-xl font-semibold tracking-tight">{shop.name}</span>
            </Link>
            <SiteLanguageSwitch current={lang} homeLang={homeLang} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
