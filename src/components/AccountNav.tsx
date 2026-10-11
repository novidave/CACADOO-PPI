"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Menu of the login-only area; the page you are on is bold and underlined. The shop pages
 * (Môj obchod, AI asistent, Priečinok s exportom, Predplatné a doména) keep the shop that is
 * open (?shop=…), so an owner with several shops stays on the same shop between them.
 */
export function AccountNav({ links }: { links: { href: string; label: string; shopPage?: boolean }[] }) {
  const pathname = usePathname() ?? "";
  const shop = useSearchParams()?.get("shop") ?? "";
  // The most specific link wins ("/sk/dashboard/plan" over "/sk/dashboard").
  const current = links
    .filter((link) => pathname === link.href || pathname.startsWith(`${link.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <>
      {links.map((link) => {
        const active = link.href === current;
        const href = link.shopPage && shop ? `${link.href}?${new URLSearchParams({ shop })}` : link.href;
        return (
          <Link
            key={link.href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={active ? "font-semibold underline underline-offset-4" : "text-muted hover:text-foreground hover:underline"}
          >
            {link.label}
          </Link>
        );
      })}
    </>
  );
}
