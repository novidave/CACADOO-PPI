"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import {
  isBareScreen,
  isWorkScreen,
  MENU_GROUPS,
  menuHref,
  menuItemFor,
  OWNER_MENU,
  withoutLang,
  type MenuGroup,
  type MenuItem,
  type MenuKey,
} from "@/lib/dashboardPages";
import { NAV_ICONS } from "./navIcons";

/** One menu item as the server prepared it: its label and, per shop slug, the number on its badge. */
export interface NavItemView {
  key: MenuKey;
  label: string;
  badges?: Record<string, number>;
  /** The badge for screen readers: "{n} …". */
  badgeLabel?: string;
}

export interface NavShop {
  slug: string;
  name: string;
  /** The shop's public page (its own domain when live); null while the shop is not shown to visitors. */
  page: string | null;
}

export interface NavLabels {
  nav: string;
  groups: Record<MenuGroup, string>;
  shop: string;
  shops: string;
  add_shop: string;
  view_page: string;
  open_menu: string;
  close_menu: string;
  /** "{n} položiek" by Intl plural category ("one", "few", "other"). */
  items: Record<string, string>;
  sign_out: string;
  signed_in: string;
}

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => String(v[k] ?? m));

function Icon({ d, size = 22 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
      <path d={d} />
    </svg>
  );
}

/** The tapped link looks pressed while its page is being read (the performance pass's first-tap feedback). */
function Pending({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus();
  return (
    <span aria-busy={pending || undefined} className={`contents ${pending ? "[&>*]:opacity-60" : ""}`} data-link-pending={pending || undefined}>
      {children}
    </span>
  );
}

/**
 * The owner menu (back-end layout, 2026-11-03; canvas "Cacaduu – webová aplikácia (Môj obchod)", artboards 19 and 21):
 * - 1024 px and wider: 256 px — the shop switcher with "Zobraziť moju stránku", Hlavné (52 px rows, 17 px), then
 *   "Stránka obchodu" and "Účet a nastavenia", only one of them open (the one holding the page opens by itself);
 * - 768–1023 px, and the work screens at any width: the 76 px rail — the shop's initial, icons 52×48 with their name
 *   for screen readers and as a tooltip, the badge in the corner, thin lines between the groups;
 * - under 768 px: a top bar (the page's name, a 48 px menu button) and the menu as a bottom sheet (a modal <dialog>:
 *   Esc or a tap outside closes it and the focus goes back to the button).
 * The map is @/lib/dashboardPages (OWNER_MENU); labels and badges come from the server. A layout is not drawn again
 * when the page changes, so the current item and the open shop (?shop=) are read here from the address.
 */
export function OwnerNav({
  lang,
  items,
  shops,
  labels,
  account,
}: {
  lang: string;
  items: NavItemView[];
  shops: NavShop[];
  labels: NavLabels;
  /** Server-drawn parts at the end of "Účet a nastavenia" (the language picker, who is signed in). */
  account?: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const params = useSearchParams();
  const path = withoutLang(pathname);
  const at = params?.get("at") ?? "";
  const shopParam = params?.get("shop") ?? "";
  const shop = shops.find((s) => s.slug === shopParam) ?? shops[0] ?? null;
  const current = menuItemFor(path, at);
  const work = isWorkScreen(path);

  // only one group open: the one holding the page, until the owner opens the other one (or closes it) on this page
  const holding: MenuGroup = current?.group === "account" ? "account" : "page";
  const [choice, setChoice] = useState<{ on: string; open: MenuGroup | null } | null>(null);
  const open = choice?.on === pathname ? choice.open : holding;
  const toggle = (group: MenuGroup) => setChoice({ on: pathname, open: open === group ? null : group });
  const [sheetAccount, setSheetAccount] = useState(false);

  const sheet = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  if (isBareScreen(path)) return null;

  const byKey = new Map(items.map((i) => [i.key, i]));
  const shown = OWNER_MENU.filter((m) => byKey.has(m.key));
  const inGroup = (g: MenuGroup) => shown.filter((m) => m.group === g);
  const labelOf = (m: MenuItem) => byKey.get(m.key)?.label ?? m.key;
  const badgeOf = (m: MenuItem) => (shop ? (byKey.get(m.key)?.badges?.[shop.slug] ?? 0) : 0);
  const ariaOf = (m: MenuItem) => {
    const n = badgeOf(m);
    const view = byKey.get(m.key);
    return n > 0 && view?.badgeLabel ? `${labelOf(m)}, ${fill(view.badgeLabel, { n })}` : labelOf(m);
  };
  const hrefOf = (m: MenuItem) => menuHref(m, lang, shopParam || null);
  const switchTo = (slug: string) => menuHref(current ?? OWNER_MENU.find((m) => m.key === "shop")!, lang, slug);
  const count = (n: number) => fill(labels.items[new Intl.PluralRules(lang).select(n)] ?? labels.items.other, { n });
  const closeSheet = () => sheet.current?.close();

  // ---- the menu beside the page (768 px and wider) ----
  // `work` = always the rail; otherwise the rail up to 1023 px and the full menu from 1024 px
  const R = (railOnly: string, responsive: string) => (work ? railOnly : responsive);
  const row = (m: MenuItem, big: boolean) => {
    const on = m.key === current?.key;
    const n = badgeOf(m);
    return (
      <Link
        key={m.key}
        href={hrefOf(m)}
        aria-current={on ? "page" : undefined}
        aria-label={ariaOf(m)}
        title={labelOf(m)}
        data-nav-item={m.key}
        className={`relative mx-auto flex h-12 w-[52px] flex-none items-center justify-center rounded-xl ${
          work ? "" : `lg:mx-0 lg:h-auto lg:w-auto lg:justify-start lg:gap-2.5 lg:px-3 ${big ? "lg:min-h-[52px] lg:text-[17px]" : "lg:min-h-[46px] lg:text-base"}`
        } ${on ? "bg-[#111] font-bold text-white" : "font-semibold text-[#111] hover:bg-[#F4F4F4]"}`}
      >
        <Pending>
          <Icon d={NAV_ICONS[m.key]} />
          <span className={R("sr-only", "sr-only lg:not-sr-only lg:min-w-0 lg:flex-1")}>{labelOf(m)}</span>
          {n > 0 && (
            <span
              aria-hidden="true"
              data-nav-badge={n}
              className={`absolute right-0.5 top-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[5px] text-[11px] font-bold ${
                work ? "" : "lg:static lg:h-[22px] lg:min-w-[22px] lg:px-1.5 lg:text-xs"
              } ${on ? "bg-white text-[#111]" : "bg-[#111] text-white"}`}
            >
              {n > 99 ? "99+" : n}
            </span>
          )}
        </Pending>
      </Link>
    );
  };
  const line = <span aria-hidden="true" className={R("mx-3 my-1.5 h-px bg-[#E4E4E4]", "mx-3 my-1.5 h-px bg-[#E4E4E4] lg:hidden")} />;
  const groupHead = (g: MenuGroup) => (
    <button
      type="button"
      onClick={() => toggle(g)}
      aria-expanded={open === g}
      aria-controls={`owner-nav-${g}`}
      data-nav-group={g}
      className={R(
        "hidden",
        "mt-2 hidden min-h-[46px] items-center justify-between border-t border-[#E4E4E4] px-3.5 text-xs font-bold uppercase tracking-[.06em] text-[#5C5C5C] lg:flex",
      )}
    >
      {labels.groups[g]}
      <span className={open === g ? "rotate-180" : ""}>
        <Icon d={NAV_ICONS.chevron} size={18} />
      </span>
    </button>
  );
  const groupList = (g: MenuGroup) => (
    <div id={`owner-nav-${g}`} className={`flex flex-col gap-0.5 ${work || open === g ? "" : "lg:hidden"}`} data-nav-list={g}>
      {inGroup(g).map((m) => row(m, false))}
      {g === "account" && (
        <form action="/auth/signout" method="post" className="contents">
          <button
            type="submit"
            title={labels.sign_out}
            aria-label={labels.sign_out}
            className={`relative mx-auto flex h-12 w-[52px] flex-none items-center justify-center rounded-xl font-semibold text-[#111] hover:bg-[#F4F4F4] ${
              work ? "" : "lg:mx-0 lg:h-auto lg:min-h-[46px] lg:w-auto lg:justify-start lg:gap-3 lg:px-3.5 lg:text-base"
            }`}
            data-nav-signout
          >
            <Icon d={NAV_ICONS.signout} />
            <span className={R("sr-only", "sr-only lg:not-sr-only")}>{labels.sign_out}</span>
          </button>
        </form>
      )}
      {g === "account" && account && <div className={R("hidden", "hidden px-3.5 pt-2 lg:flex lg:flex-col lg:gap-2")}>{account}</div>}
    </div>
  );
  const shopList = (wide: boolean) => (
    <div
      className={`absolute z-40 flex flex-col gap-0.5 rounded-xl border border-[#E4E4E4] bg-white p-1.5 shadow-[0_8px_24px_rgba(17,17,17,.12)] ${
        // the rail scrolls (overflow), so its list is placed on the screen beside it, not inside it
        wide ? "left-0 right-0 top-full mt-1" : "fixed left-[84px] top-3 w-64"
      }`}
    >
      <span className="px-3 pb-1 pt-1.5 text-xs font-bold uppercase tracking-[.06em] text-[#5C5C5C]">{labels.shops}</span>
      {shops.map((s) => (
        <Link
          key={s.slug}
          href={switchTo(s.slug)}
          aria-current={s.slug === shop?.slug ? "true" : undefined}
          className={`flex min-h-11 items-center rounded-lg px-3 text-base ${s.slug === shop?.slug ? "bg-[#F4F4F4] font-bold" : "font-semibold"}`}
        >
          {s.name}
        </Link>
      ))}
      <Link href={`/${lang}/dashboard?new=1`} className="flex min-h-11 items-center rounded-lg px-3 text-base font-semibold">
        {labels.add_shop}
      </Link>
    </div>
  );
  const switcher = (
    <>
      <div className={R("hidden", "hidden items-stretch gap-2 lg:flex")} data-shop-switcher>
        <details className="group relative min-w-0 flex-1">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-1.5 rounded-xl border border-[#E4E4E4] px-3 [&::-webkit-details-marker]:hidden">
            <span className="flex min-w-0 flex-col">
              <span className="text-xs text-[#5C5C5C]">{labels.shop}</span>
              <strong className="truncate text-base">{shop?.name ?? ""}</strong>
            </span>
            <span className="group-open:rotate-180">
              <Icon d={NAV_ICONS.chevron} size={18} />
            </span>
          </summary>
          {shopList(true)}
        </details>
        {shop?.page && (
          <a
            href={shop.page}
            target="_blank"
            rel="noopener"
            aria-label={labels.view_page}
            title={labels.view_page}
            className="flex w-[52px] flex-none items-center justify-center rounded-xl border border-[#E4E4E4] text-[#111]"
            data-view-page
          >
            <Icon d={NAV_ICONS.open} size={20} />
          </a>
        )}
      </div>
      <details className={R("relative", "relative lg:hidden")}>
        <summary
          aria-label={`${labels.shop}: ${shop?.name ?? ""}`}
          title={shop?.name ?? ""}
          className="mx-auto flex size-[52px] cursor-pointer list-none items-center justify-center rounded-xl border border-[#E4E4E4] text-lg font-bold [&::-webkit-details-marker]:hidden"
        >
          {(shop?.name ?? "?").trim().charAt(0).toUpperCase()}
        </summary>
        {shopList(false)}
      </details>
    </>
  );

  // ---- the phone: the top bar and the bottom sheet ----
  const tile = (m: MenuItem) => {
    const on = m.key === current?.key;
    const n = badgeOf(m);
    return (
      <Link
        key={m.key}
        href={hrefOf(m)}
        onClick={closeSheet}
        aria-current={on ? "page" : undefined}
        aria-label={ariaOf(m)}
        data-sheet-item={m.key}
        className={`relative flex min-h-[92px] flex-col justify-between gap-2 rounded-2xl border p-3.5 ${on ? "border-[#111] bg-[#111] text-white" : "border-[#E4E4E4] text-[#111]"}`}
      >
        <Icon d={NAV_ICONS[m.key]} size={26} />
        <strong className="text-[17px] leading-tight">{labelOf(m)}</strong>
        {n > 0 && (
          <span
            aria-hidden="true"
            className={`absolute right-2.5 top-2.5 inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-xs font-bold ${on ? "bg-white text-[#111]" : "bg-[#111] text-white"}`}
          >
            {n > 99 ? "99+" : n}
          </span>
        )}
      </Link>
    );
  };
  const sheetRow = (m: MenuItem) => {
    const on = m.key === current?.key;
    return (
      <Link
        key={m.key}
        href={hrefOf(m)}
        onClick={closeSheet}
        aria-current={on ? "page" : undefined}
        data-sheet-item={m.key}
        className={`flex min-h-[50px] items-center gap-3.5 rounded-xl px-3.5 text-base ${on ? "bg-[#111] font-bold text-white" : "font-semibold text-[#111]"}`}
      >
        <Icon d={NAV_ICONS[m.key]} />
        {labelOf(m)}
      </Link>
    );
  };
  const accountItems = inGroup("account");

  return (
    <>
      {/* under 768 px */}
      <div className="sticky top-0 z-30 flex min-h-14 items-center justify-between gap-3 border-b border-[#E4E4E4] bg-white px-4 md:hidden" data-owner-topbar>
        <strong className="min-w-0 truncate text-lg">{current ? labelOf(current) : (shop?.name ?? "")}</strong>
        <button
          ref={opener}
          type="button"
          aria-label={labels.open_menu}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          onClick={() => {
            sheet.current?.showModal();
            setSheetOpen(true);
          }}
          className="flex size-12 flex-none items-center justify-center rounded-xl border border-[#E4E4E4]"
          data-owner-menu-button
        >
          <Icon d={NAV_ICONS.menu} />
        </button>
      </div>
      <dialog
        ref={sheet}
        aria-label={labels.nav}
        onClose={() => {
          setSheetOpen(false);
          opener.current?.focus();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeSheet();
        }}
        className="fixed inset-x-0 bottom-0 top-auto m-0 h-[calc(100dvh-56px)] max-h-none w-full max-w-none rounded-t-[20px] bg-white p-0 text-[#111] backdrop:bg-[#111]/40 md:hidden"
        data-owner-sheet
      >
        <div className="flex h-full flex-col gap-1.5 overflow-y-auto px-3 pb-5 pt-2.5">
          <span aria-hidden="true" className="mb-0.5 h-[5px] w-11 self-center rounded-full bg-[#D6D6D6]" />
          <div className="flex items-center justify-between gap-2 px-1">
            <details className="relative min-w-0">
              <summary className="flex min-h-[52px] cursor-pointer list-none flex-col justify-center [&::-webkit-details-marker]:hidden">
                <span className="text-xs text-[#5C5C5C]">{labels.shop} ▾</span>
                <strong className="truncate text-[17px]">{shop?.name ?? ""}</strong>
              </summary>
              {shopList(true)}
            </details>
            <button type="button" onClick={closeSheet} aria-label={labels.close_menu} className="flex size-12 flex-none items-center justify-center rounded-xl">
              <Icon d={NAV_ICONS.close} />
            </button>
          </div>
          <span className="px-3.5 pb-0.5 pt-1 text-xs font-bold uppercase tracking-[.06em] text-[#5C5C5C]">{labels.groups.main}</span>
          <nav aria-label={labels.groups.main} className="grid grid-cols-2 gap-2">
            {inGroup("main").map(tile)}
          </nav>
          <span className="px-3.5 pb-0.5 pt-3 text-xs font-bold uppercase tracking-[.06em] text-[#5C5C5C]">{labels.groups.page}</span>
          <nav aria-label={labels.groups.page} className="flex flex-col">
            {inGroup("page").map(sheetRow)}
          </nav>
          <button
            type="button"
            aria-expanded={sheetAccount}
            aria-controls="owner-sheet-account"
            onClick={() => setSheetAccount((v) => !v)}
            className="mt-1 flex min-h-[52px] items-center justify-between border-t border-[#E4E4E4] px-3.5 text-base font-bold"
          >
            {labels.groups.account}
            <span className="text-sm font-semibold text-[#5C5C5C]">
              {count(accountItems.length + 1)} {sheetAccount ? "▴" : "▾"}
            </span>
          </button>
          <nav id="owner-sheet-account" aria-label={labels.groups.account} className={sheetAccount ? "flex flex-col" : "hidden"}>
            {accountItems.map(sheetRow)}
            <form action="/auth/signout" method="post" className="contents">
              <button type="submit" className="flex min-h-[50px] items-center gap-3.5 rounded-xl px-3.5 text-left text-base font-semibold">
                <Icon d={NAV_ICONS.signout} />
                {labels.sign_out}
              </button>
            </form>
            {account && <div className="flex flex-col gap-2 px-3.5 pt-2">{account}</div>}
          </nav>
        </div>
      </dialog>

      {/* 768 px and wider */}
      <aside
        className={`sticky top-0 hidden h-svh flex-none flex-col gap-2 overflow-y-auto border-r border-[#E4E4E4] bg-white px-3 py-3.5 md:flex ${work ? "w-[76px]" : "w-[76px] lg:w-64"}`}
        data-owner-nav={work ? "rail" : "menu"}
      >
        {switcher}
        <nav aria-label={labels.nav} className="flex min-h-0 flex-1 flex-col gap-0.5">
          <span className={R("hidden", "hidden px-3.5 pb-1 pt-2.5 text-xs font-bold uppercase tracking-[.06em] text-[#5C5C5C] lg:block")}>{labels.groups.main}</span>
          {inGroup("main").map((m) => row(m, true))}
          {MENU_GROUPS.filter((g) => g !== "main").map((g) => (
            <div key={g} className="flex flex-col gap-0.5">
              {groupHead(g)}
              {line}
              {groupList(g)}
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
