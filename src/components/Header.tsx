import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { LanguageSwitch } from "./LanguageSwitch";

export function Header({ lang, siteName, forShops }: { lang: Locale; siteName: string; forShops: string }) {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-3">
        <Link href={`/${lang}`} aria-label={siteName} className="shrink-0">
          {/* The Cacadoo PPI logo (the site's only coloured artwork, chosen by the owner). */}
          {/* eslint-disable-next-line @next/next/no-img-element -- small static logo, exact size given */}
          <img src="/brand/cacadoo-ppi.png" alt={siteName} width={835} height={179} className="h-8 w-auto sm:h-9" />
        </Link>
        <div className="flex items-center gap-4">
          <Link href={`/${lang}/login`} className="text-sm text-muted hover:text-foreground">
            {forShops}
          </Link>
          <LanguageSwitch current={lang} />
        </div>
      </div>
    </header>
  );
}
