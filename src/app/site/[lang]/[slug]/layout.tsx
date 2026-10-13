import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { siteLang, sitePath } from "@/lib/customDomain";
import { getShop } from "@/lib/data";
import { getHeaderPicture } from "@/lib/sections";
import { SiteLanguageSwitch } from "@/components/LanguageSwitch";
import "../../../globals.css";

/**
 * The layout of a shop's own domain (database update 25): no Cacadoo header. The shop's own
 * header: the SK · HU · EN switch and, when the owner chose one, its header picture across the
 * top (database update 28; 1600 / 800 px with srcset, a link to the shop's home). The shop's
 * name and logo are on the page itself, above its details. Only src/proxy.ts sends visitors
 * here (the page and its items).
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
  const picture = await getHeaderPicture(slug).catch(() => null);

  return (
    <html lang={lang} className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-white text-foreground">
        <header className="border-b border-line" data-site-header>
          <div className="mx-auto flex w-full max-w-5xl items-center justify-end gap-3 px-4 py-2">
            <SiteLanguageSwitch current={lang} homeLang={homeLang} />
          </div>
          {picture && (
            <Link href={sitePath(lang, homeLang)} className="block" aria-label={shop.name} data-header-picture>
              {/* eslint-disable-next-line @next/next/no-img-element -- already 1600 / 800 px: srcset, no optimisation */}
              <img
                src={picture.small_url}
                srcSet={`${picture.small_url} 800w, ${picture.url} 1600w`}
                sizes="100vw"
                width={picture.width}
                height={picture.height}
                alt={shop.name}
                fetchPriority="high"
                className="block h-auto max-h-[40vh] w-full object-cover"
              />
            </Link>
          )}
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
