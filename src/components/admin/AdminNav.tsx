"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { adminKeyFor, type AdminGroup, type AdminKey } from "@/lib/adminPages";

/**
 * The admin area's menu (2026-11-05, canvas "Cacaduu – Admin", artboard 14): from 768 px a 256 px column — "Cacaduu"
 * + the black ADMIN pill, "Späť do Môj obchod" (48 px), the three groups with 46 px items (the current one black,
 * white text, aria-current; badges as 22 px pills), the admin's name and e-mail at the bottom. Below 768 px a top bar
 * (a 48 px menu button + the page's name) and the same menu as a bottom sheet (a modal <dialog>: Esc, a tap outside or
 * a link closes it; the focus goes back to the button). The current item comes from the address: a layout is not
 * drawn again on navigation.
 */

export interface AdminNavItem {
  key: AdminKey;
  group: AdminGroup;
  label: string;
  href: string;
  badge?: number;
  badgeLabel?: string;
}

/** One SVG path each, 21 px, stroke 2, currentColor (the canvas's AdminNav). */
const ICONS: Record<AdminKey, string> = {
  home: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  shops: "M4 10h16v10H4zM3 10l2-6h14l2 6",
  errors: "M12 3l10 18H2zM12 10v5M12 18h.01",
  domains: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  limits: "M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6",
  sms: "M4 5h16v11H9l-5 4z",
  integrations: "M21 3L3 11l7 3 3 7z",
  translations: "M4 5h8M8 3v2M6 5c0 4 3 7 6 8M10 5c0 4-3 7-6 8M13 21l4-10 4 10M14.5 18h5",
  search: "M11 18a7 7 0 1 0 0-14a7 7 0 1 0 0 14zM20 20l-4-4",
  partners: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  inventory: "M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8",
  holidays: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M8 3v4M16 3v4",
};

const Icon = ({ d, size = 21 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
    <path d={d} />
  </svg>
);

export function AdminNav({
  items,
  groups,
  backHref,
  user,
  labels,
}: {
  items: AdminNavItem[];
  groups: { key: AdminGroup; label: string }[];
  backHref: string;
  user: { name: string; email: string };
  labels: { nav: string; pill: string; back: string; role: string; open: string; close: string };
}) {
  const pathname = usePathname() ?? "";
  const current = adminKeyFor(pathname);
  const title = items.find((i) => i.key === current)?.label ?? labels.pill;
  const sheet = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  // a link in the sheet navigates: the sheet closes with the new page
  useEffect(() => {
    sheet.current?.close();
  }, [pathname]);

  const menu = (id: string) => (
    <nav aria-label={labels.nav} id={id} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
      {groups.map((g) => (
        <div key={g.key} className="flex flex-col gap-0.5" data-admin-group={g.key}>
          <span className="px-3 pb-1 pt-3 text-xs font-bold uppercase tracking-[.06em] text-[#5C5C5C]">{g.label}</span>
          {items
            .filter((i) => i.group === g.key)
            .map((i) => {
              const on = i.key === current;
              return (
                <Link
                  key={i.key}
                  href={i.href}
                  aria-current={on ? "page" : undefined}
                  data-admin-item={i.key}
                  className={`flex min-h-[46px] flex-none items-center gap-3 rounded-xl px-3 text-[15px] no-underline ${on ? "bg-[#111] font-bold text-white" : "font-semibold text-[#111] hover:bg-[#F4F4F4]"}`}
                >
                  <Icon d={ICONS[i.key]} />
                  <span className="min-w-0 flex-1">{i.label}</span>
                  {i.badge ? (
                    <span
                      className={`inline-flex h-[22px] min-w-[22px] flex-none items-center justify-center rounded-full px-1.5 text-xs font-bold ${on ? "bg-white text-[#111]" : "bg-[#111] text-white"}`}
                      aria-label={i.badgeLabel}
                      title={i.badgeLabel}
                      data-admin-badge={i.key}
                    >
                      {i.badge > 99 ? "99+" : i.badge}
                    </span>
                  ) : null}
                </Link>
              );
            })}
        </div>
      ))}
    </nav>
  );

  const head = (
    <>
      <div className="flex min-h-11 items-center justify-between gap-2 px-1.5">
        <strong className="text-[19px]">Cacaduu</strong>
        <span className="inline-flex h-[26px] items-center rounded-full bg-[#111] px-2.5 text-xs font-bold tracking-[.04em] text-white">{labels.pill}</span>
      </div>
      <a href={backHref} className="flex min-h-12 items-center gap-2.5 rounded-xl border border-[#E4E4E4] px-3 text-[15px] font-bold text-[#111] no-underline hover:bg-[#F4F4F4]" data-admin-back>
        <Icon d="M15 6l-6 6 6 6" size={20} />
        {labels.back}
      </a>
    </>
  );

  const foot = (
    <div className="flex flex-col gap-0.5 border-t border-[#E4E4E4] px-3 pt-2.5 text-[13px]" data-admin-user>
      {user.name && <strong className="text-sm">{user.name}</strong>}
      <span className="break-all text-[#5C5C5C]">
        {labels.role} · {user.email}
      </span>
    </div>
  );

  return (
    <>
      {/* a computer or a tablet: the 256 px column */}
      <aside className="sticky top-0 hidden h-svh w-64 flex-none flex-col gap-1.5 border-r border-[#E4E4E4] bg-white px-3 py-3.5 md:flex" data-admin-menu>
        {head}
        {menu("admin-menu")}
        {foot}
      </aside>

      {/* a phone: the top bar and the bottom sheet */}
      <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-[#E4E4E4] bg-white px-2 md:hidden" data-admin-topbar>
        <button
          ref={button}
          type="button"
          className="flex size-12 flex-none items-center justify-center rounded-xl"
          aria-label={labels.open}
          aria-expanded={open}
          aria-controls="admin-sheet"
          onClick={() => {
            sheet.current?.showModal();
            setOpen(true);
          }}
          data-admin-menu-button
        >
          <Icon d="M4 7h16M4 12h16M4 17h16" size={24} />
        </button>
        <span className="min-w-0 flex-1 truncate text-lg font-bold">{title}</span>
        <span className="inline-flex h-6 flex-none items-center rounded-full bg-[#111] px-2.5 text-[11px] font-bold tracking-[.04em] text-white">{labels.pill}</span>
      </header>
      <dialog
        ref={sheet}
        id="admin-sheet"
        aria-label={labels.nav}
        className="ppi-admin-sheet m-0 mt-auto max-h-[85svh] w-full max-w-none flex-col gap-1.5 rounded-t-2xl border-0 bg-white px-3 pb-[max(14px,env(safe-area-inset-bottom))] pt-2 text-[#111] backdrop:bg-[#111]/40 open:flex md:hidden"
        onClose={() => {
          setOpen(false);
          button.current?.focus();
        }}
        onClick={(e) => {
          // a tap on the backdrop (outside the sheet's box) closes it
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
        data-admin-sheet
      >
        <div className="flex items-center justify-between gap-2">
          <span aria-hidden="true" className="mx-auto mt-1 h-1 w-10 rounded-full bg-[#D6D6D6]" />
        </div>
        <div className="flex items-center justify-end">
          <button type="button" className="flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-[15px] font-bold" onClick={() => sheet.current?.close()} data-admin-sheet-close>
            <Icon d="M6 6l12 12M18 6L6 18" size={20} />
            {labels.close}
          </button>
        </div>
        {head}
        {menu("admin-sheet-menu")}
        {foot}
      </dialog>
    </>
  );
}
