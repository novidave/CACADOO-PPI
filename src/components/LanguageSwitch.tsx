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
