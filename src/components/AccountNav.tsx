"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/** The tapped menu link looks pressed while its page is being read (performance pass: feedback at the first tap). */
function Label({ text, badge, badgeLabel }: { text: string; badge?: number; badgeLabel?: string }) {
  const { pending } = useLinkStatus();
  return (
    <span aria-busy={pending || undefined} className={pending ? "opacity-60" : undefined} data-link-pending={pending || undefined}>
      {text}
      {badge ? (
        <span
          className="ml-1 inline-flex min-w-5 items-center justify-center rounded-full bg-foreground px-1.5 text-xs font-semibold text-white"
          aria-label={badgeLabel}
          data-nav-badge={badge}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Menu of the login-only area; the page you are on is bold and underlined. The shop pages
 * (Môj obchod, AI asistent, Priečinok s exportom, Predplatné a doména) keep the shop that is
 * open (?shop=…), so an owner with several shops stays on the same shop between them.
 */
export function AccountNav({ links }: { links: { href: string; label: string; shopPage?: boolean; badge?: number; badgeLabel?: string }[] }) {
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
            <Label text={link.label} badge={link.badge} badgeLabel={link.badgeLabel} />
          </Link>
        );
      })}
    </>
  );
}
