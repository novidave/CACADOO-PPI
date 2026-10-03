/** Public site address for canonical links, sitemap and JSON-LD. */
export function siteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "http://localhost:3000";
}

/** Canonical URL of this page in this language, plus the same page in the other languages. */
export function pageAlternates(lang: string, path: string, locales: readonly string[]) {
  return {
    canonical: `/${lang}${path}`,
    languages: Object.fromEntries(locales.map((l) => [l, `/${l}${path}`])),
  };
}
