import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { LanguageSwitch } from "./LanguageSwitch";

export function Header({ lang, siteName }: { lang: Locale; siteName: string }) {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-3">
        <Link href={`/${lang}`} className="text-lg font-semibold tracking-tight">
          {siteName}
        </Link>
        <LanguageSwitch current={lang} />
      </div>
    </header>
  );
}
