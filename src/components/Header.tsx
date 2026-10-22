import Link from "next/link";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { languageOf, MAIN_RECOMMENDED } from "@/i18n/languages";
import { LanguagePicker } from "./LanguagePicker";

export function Header({ lang, dict, enabled }: { lang: Locale; dict: Dictionary; enabled: string[] }) {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3">
        <Link href={`/${lang}`} aria-label={dict.site.name} className="shrink-0">
          {/* The Cacaduu PPI logo (the site's only coloured artwork, chosen by the owner; vector, cacaduu.com). */}
          {/* eslint-disable-next-line @next/next/no-img-element -- small static logo, exact size given */}
          <img src="/brand/cacaduu-ppi.svg" alt={dict.site.name} width={722} height={196} className="h-10 w-auto sm:h-11" />
        </Link>
        <div className="flex min-w-0 items-center gap-4">
          <Link href={`/${lang}/login`} className="text-sm text-muted hover:text-foreground">
            {dict.account.for_shops}
          </Link>
          <LanguagePicker current={lang} currentNative={languageOf(lang)?.native ?? lang} enabled={enabled} recommended={MAIN_RECOMMENDED} labels={dict.languages} />
        </div>
      </div>
    </header>
  );
}
