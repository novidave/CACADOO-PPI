"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { locales, type Locale } from "@/i18n/config";

/** SK · HU · EN. Keeps the current page; src/proxy.ts remembers the choice in a cookie. */
export function LanguageSwitch({ current }: { current: Locale }) {
  const pathname = usePathname() ?? `/${current}`;
  const rest = pathname.split("/").slice(2).join("/");

  return (
    <nav aria-label="Language" className="flex items-center gap-1 text-sm">
      {locales.map((locale, i) => (
        <span key={locale} className="flex items-center gap-1">
          {i > 0 && <span className="text-muted" aria-hidden>·</span>}
          {locale === current ? (
            <span className="font-semibold underline underline-offset-4" aria-current="true">
              {locale.toUpperCase()}
            </span>
          ) : (
            <Link
              href={`/${locale}${rest ? `/${rest}` : ""}`}
              hrefLang={locale}
              className="text-muted hover:text-foreground"
            >
              {locale.toUpperCase()}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * SK · HU · EN on a shop's own domain: "/" is the shop's language, "/hu" the others, items
 * "/{lang}/items/{id}". Works from the address in the browser ("/", "/hu", "/hu/items/…",
 * "/items/…") and from the page's own path ("/site/{lang}/{slug}/items/…").
 */
export function SiteLanguageSwitch({ current, homeLang }: { current: Locale; homeLang: Locale }) {
  const pathname = usePathname() ?? "/";
  const parts = pathname.split("/").filter(Boolean);
  const rest = parts[0] === "site" ? parts.slice(3) : (locales as readonly string[]).includes(parts[0] ?? "") ? parts.slice(1) : parts;
  const item = rest[0] === "items" && rest[1] ? rest[1] : null;
  const target = (locale: Locale) => (item ? `/${locale}/items/${item}` : locale === homeLang ? "/" : `/${locale}`);

  return (
    <nav aria-label="Language" className="flex shrink-0 items-center gap-1 text-sm" data-site-languages>
      {locales.map((locale, i) => (
        <span key={locale} className="flex items-center gap-1">
          {i > 0 && <span className="text-muted" aria-hidden>·</span>}
          {locale === current ? (
            <span className="font-semibold underline underline-offset-4" aria-current="true">
              {locale.toUpperCase()}
            </span>
          ) : (
            <a href={target(locale)} hrefLang={locale} className="text-muted hover:text-foreground">
              {locale.toUpperCase()}
            </a>
          )}
        </span>
      ))}
    </nav>
  );
}
