import Link from "next/link";
import { t, type Dictionary } from "@/i18n/dictionaries";

/**
 * The footer of every Cacaduu page (2026-11-01, at the owner's request): the legal documents — "Právne informácie" (all
 * of them on one page), "Ochrana osobných údajov (GDPR)", "Súkromie v asistentovi", "Obchodné podmienky". Server only,
 * no JavaScript; plain links, 44 px touch areas, a thin grey line above.
 */
export function SiteFooter({ lang, dict }: { lang: string; dict: Dictionary }) {
  const l = dict.legal;
  const links: [string, string][] = [
    [`/${lang}/pravne-informacie`, l.footer_legal],
    [`/${lang}/sukromie`, l.footer_privacy],
    [`/${lang}/sukromie-asistent`, l.footer_assistant],
    [`/${lang}/podmienky`, l.footer_terms],
  ];
  return (
    <footer className="mt-8 border-t border-line" data-site-footer>
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-5 px-4 py-3 text-sm text-muted">
        <nav aria-label={l.footer_label} className="grid w-full grid-cols-2 gap-x-4 sm:flex sm:w-auto sm:flex-wrap sm:gap-x-5">
          {links.map(([href, label]) => (
            <Link key={href} href={href} className="flex min-h-11 items-center hover:text-foreground hover:underline">
              {label}
            </Link>
          ))}
        </nav>
        <span className="flex min-h-11 items-center sm:ml-auto">{t(l.copyright, { year: new Date().getFullYear() })}</span>
      </div>
    </footer>
  );
}
