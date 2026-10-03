"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Menu of the login-only area; the page you are on is bold and underlined. */
export function AccountNav({ links }: { links: { href: string; label: string }[] }) {
  const pathname = usePathname() ?? "";
  return (
    <>
      {links.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
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
