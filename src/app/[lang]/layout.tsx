import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { enabledLocales, getDictionary, indexedLocales } from "@/i18n/dictionaries";
import { HANDWRITTEN, languageOf } from "@/i18n/languages";
import { Suspense } from "react";
import { Header } from "@/components/Header";
import { SiteFooter } from "@/components/SiteFooter";
import { TapFeedback } from "@/components/TapFeedback";
import { siteUrl } from "@/lib/site";
import { notoFallback, quicksand } from "../fonts";
import { VercelMetrics } from "@/components/VercelMetrics";
import "../globals.css";

/** The hand-written languages at build time; the others the first time they are asked for (and only if switched on). */
export function generateStaticParams() {
  return HANDWRITTEN.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: LayoutProps<"/[lang]">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const [dict, indexed] = await Promise.all([getDictionary(lang), indexedLocales()]);
  return {
    metadataBase: new URL(siteUrl()),
    title: { default: `${dict.site.name} · ${dict.site.tagline}`, template: `%s · ${dict.site.name}` },
    description: dict.site.description,
    alternates: {
      canonical: `/${lang}`,
      // Only the pre-translated languages (update 40); the others are not indexed (below).
      languages: { ...Object.fromEntries(indexed.map((l) => [l, `/${l}`])), "x-default": "/sk" },
    },
    ...(indexed.includes(lang) ? {} : { robots: { index: false, follow: true } }),
    // Ownership proof for Google Search Console and Bing Webmaster Tools (SETUP.md part I),
    // so the sitemap can be submitted and search engines / AI assistants find the shops sooner.
    verification: {
      google: process.env.GOOGLE_SITE_VERIFICATION || undefined,
      other: process.env.BING_SITE_VERIFICATION ? { "msvalidate.01": process.env.BING_SITE_VERIFICATION } : undefined,
    },
  };
}

export default async function RootLayout({ children, params }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, enabled] = await Promise.all([getDictionary(lang), enabledLocales()]);
  // A language the admin switched off is not served.
  if (!enabled.includes(lang)) notFound();

  return (
    <html lang={lang} dir="ltr" data-script={languageOf(lang)?.script} className={`${quicksand.variable} ${notoFallback.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-white text-foreground">
        <Header lang={lang} dict={dict} enabled={enabled} />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
        <SiteFooter lang={lang} dict={dict} />
        <Suspense fallback={null}>
          <TapFeedback />
        </Suspense>
        {/* Cookie-free, only on Vercel (elsewhere their scripts do not exist); loaded after the page (privacy page). */}
        {process.env.VERCEL && <VercelMetrics />}
      </body>
    </html>
  );
}
