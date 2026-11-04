"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  isBareScreen,
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
  collapse_menu: string;
  expand_menu: string;
  sign_out: string;
  signed_in: string;
}

/** Where the computer's menu remembers "Zbaliť menu" (this device only; default open). */
export const NAV_STORAGE = "ppi.owner.nav";
const NAV_EVENT = "ppi:owner-nav";

/**
 * Runs before the shell is painted (the account layout puts it first): a menu the owner collapsed on this device starts
 * collapsed, without a jump. It only sets `<html data-owner-nav="collapsed">`; the CSS does the rest (globals.css).
 */
export const NAV_BOOT = `try{if(localStorage.getItem("${NAV_STORAGE}")==="collapsed")document.documentElement.dataset.ownerNav="collapsed"}catch(e){}`;

const collapsedNow = () => typeof document !== "undefined" && document.documentElement.dataset.ownerNav === "collapsed";
function subscribe(change: () => void) {
  window.addEventListener(NAV_EVENT, change);
  return () => window.removeEventListener(NAV_EVENT, change);
}
function setCollapsed(on: boolean) {
  if (on) document.documentElement.dataset.ownerNav = "collapsed";
  else delete document.documentElement.dataset.ownerNav;
  try {
    window.localStorage.setItem(NAV_STORAGE, on ? "collapsed" : "open");
  } catch {
    // blocked storage: the choice lasts for this page only
  }
  window.dispatchEvent(new Event(NAV_EVENT));
}

function Icon({ d, size = 22, className = "" }: { d: string; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`flex-none ${className}`}
    >
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

/** Every row's icon sits in the same 52 px box (in a 76 px column: 12 px margin on each side), open or collapsed. */
const iconBox = "flex w-[52px] flex-none items-center justify-center";

/**
 * The owner menu (back-end layout, 2026-11-03; open by default and collapsible since 2026-11-04):
 * - 1024 px and wider: the 256 px menu beside the page, OPEN on every page (also Predaj, the Príjemka editor,
 *   Inventúra counting and the food board). "Zbaliť menu" at its bottom collapses it to a 76 px rail and back,
 *   remembered on this device (localStorage `ppi.owner.nav`). The rows are the same in both states — the shop switcher
 *   (56 px), "Zobraziť moju stránku" (52 px), "Hlavné" (52 px rows), the group heads and rows (46 px) — and every icon
 *   sits in the same 52 px box of a fixed 76 px column, so collapsing only hides the labels (badges move to the icon's
 *   corner) and no icon moves. Only the width is animated (nothing with `prefers-reduced-motion`).
 * - under 1024 px (phones and tablets): a top bar with the 48 px menu button on the LEFT and the page's name; the
 *   button opens the same menu as a panel from the left (a modal <dialog>, ≤ 320 px or 85 % of the width, the page
 *   dimmed; Esc, a tap outside or × closes it and the focus goes back to the button).
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

  // only one group open: the one holding the page, until the owner opens the other one (or closes it) on this page
  const holding: MenuGroup = current?.group === "account" ? "account" : "page";
  const [choice, setChoice] = useState<{ on: string; open: MenuGroup | null } | null>(null);
  const open = choice?.on === pathname ? choice.open : holding;
  const toggle = (group: MenuGroup) => setChoice({ on: pathname, open: open === group ? null : group });

  const collapsed = useSyncExternalStore(subscribe, collapsedNow, () => false);
  const panel = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  if (isBareScreen(path)) return null;

  const byKey = new Map(items.map((i) => [i.key, i]));
  const shown = OWNER_MENU.filter((m) => byKey.has(m.key));
  const inGroup = (g: MenuGroup) => shown.filter((m) => m.group === g);
  const labelOf = (m: MenuItem) => byKey.get(m.key)?.label ?? m.key;
  const badgeOf = (m: MenuItem) => (shop ? (byKey.get(m.key)?.badges?.[shop.slug] ?? 0) : 0);
  const ariaOf = (m: MenuItem) => {
    const n = badgeOf(m);
    const view = byKey.get(m.key);
    return n > 0 && view?.badgeLabel ? `${labelOf(m)}, ${view.badgeLabel.replace("{n}", String(n))}` : labelOf(m);
  };
  const hrefOf = (m: MenuItem) => menuHref(m, lang, shopParam || null);
  const switchTo = (slug: string) => menuHref(current ?? OWNER_MENU.find((m) => m.key === "shop")!, lang, slug);
  const closePanel = () => panel.current?.close();

  /** The menu itself — the same rows beside the page (`aside`) and in the phone's panel (`panel`). */
  const body = (where: "aside" | "panel") => {
    const inPanel = where === "panel";
    const attr = inPanel ? "data-panel-item" : "data-nav-item";
    const onNavigate = inPanel ? closePanel : undefined;
    const row = (m: MenuItem, big: boolean) => {
      const on = m.key === current?.key;
      const n = badgeOf(m);
      return (
        <Link
          key={m.key}
          href={hrefOf(m)}
          onClick={onNavigate}
          aria-current={on ? "page" : undefined}
          aria-label={ariaOf(m)}
          title={labelOf(m)}
          {...{ [attr]: m.key }}
          className={`ppi-nav-row relative mx-3 flex flex-none items-center overflow-hidden rounded-xl outline-offset-[-2px] ${big ? "h-[52px] text-[17px]" : "h-[46px] text-base"} ${
            on ? "bg-[#111] font-bold text-white" : "font-semibold text-[#111] hover:bg-[#F4F4F4]"
          }`}
        >
          <Pending>
            <span className={iconBox} data-nav-icon>
              <Icon d={NAV_ICONS[m.key]} />
            </span>
            <span className="min-w-0 flex-1 truncate pr-2" data-nav-label>
              {labelOf(m)}
            </span>
            {n > 0 && (
              <span
                aria-hidden="true"
                data-nav-badge={n}
                className={`mr-2.5 inline-flex h-[22px] min-w-[22px] flex-none items-center justify-center rounded-full px-1.5 text-xs font-bold ${on ? "bg-white text-[#111]" : "bg-[#111] text-white"}`}
              >
                {n > 99 ? "99+" : n}
              </span>
            )}
          </Pending>
        </Link>
      );
    };
    const groupHead = (g: MenuGroup) => (
      <button
        type="button"
        onClick={() => toggle(g)}
        aria-expanded={open === g}
        aria-controls={`owner-${where}-${g}`}
        aria-label={labels.groups[g]}
        title={labels.groups[g]}
        data-nav-group={g}
        className="mx-3 mt-1.5 flex h-[46px] flex-none items-center overflow-hidden rounded-xl border-t border-[#E4E4E4] text-[#5C5C5C] outline-offset-[-2px] hover:text-[#111]"
      >
        <span className={iconBox} data-nav-icon>
          <Icon d={NAV_ICONS[g === "page" ? "group_page" : "group_account"]} size={18} />
        </span>
        <span className="flex min-w-0 flex-1 items-center justify-between gap-2 pr-2.5" data-nav-label>
          <span className="truncate text-xs font-bold uppercase tracking-[.06em]">{labels.groups[g]}</span>
          <Icon d={NAV_ICONS.chevron} size={18} className={open === g ? "rotate-180" : ""} />
        </span>
      </button>
    );
    const groupList = (g: MenuGroup) => (
      <div id={`owner-${where}-${g}`} className={`flex flex-col gap-0.5 ${open === g ? "" : "hidden"}`} data-nav-list={g}>
        {inGroup(g).map((m) => row(m, false))}
        {g === "account" && (
          <form action="/auth/signout" method="post" className="contents">
            <button
              type="submit"
              title={labels.sign_out}
              aria-label={labels.sign_out}
              className="ppi-nav-row relative mx-3 flex h-[46px] flex-none items-center overflow-hidden rounded-xl text-left text-base font-semibold text-[#111] outline-offset-[-2px] hover:bg-[#F4F4F4]"
              data-nav-signout
            >
              <span className={iconBox} data-nav-icon>
                <Icon d={NAV_ICONS.signout} />
              </span>
              <span className="min-w-0 flex-1 truncate pr-2" data-nav-label>
                {labels.sign_out}
              </span>
            </button>
          </form>
        )}
        {g === "account" && account && (
          <div className="flex flex-col gap-2 px-[26px] pb-2 pt-2" data-nav-extra>
            {account}
          </div>
        )}
      </div>
    );
    const initial = (shop?.name ?? "?").trim().charAt(0).toUpperCase();
    return (
      <>
        <div className="flex flex-none flex-col gap-1.5 pt-3.5">
          <details className="group relative" data-shop-switcher>
            <summary
              aria-label={`${labels.shop}: ${shop?.name ?? ""}`}
              title={shop?.name ?? ""}
              className="mx-3 flex h-14 cursor-pointer list-none items-center overflow-hidden rounded-xl border border-[#E4E4E4] outline-offset-[-2px] [&::-webkit-details-marker]:hidden"
            >
              <span className={iconBox} data-nav-icon>
                <span className="flex size-9 items-center justify-center rounded-lg bg-[#F4F4F4] text-base font-bold">{initial}</span>
              </span>
              <span className="flex min-w-0 flex-1 items-center justify-between gap-1.5 pr-2.5" data-nav-label>
                <span className="flex min-w-0 flex-col">
                  <span className="text-xs text-[#5C5C5C]">{labels.shop}</span>
                  <strong className="truncate text-base">{shop?.name ?? ""}</strong>
                </span>
                <span className="group-open:rotate-180">
                  <Icon d={NAV_ICONS.chevron} size={18} />
                </span>
              </span>
            </summary>
            <div
              className="ppi-shop-list absolute left-3 right-3 top-full z-40 mt-1 flex flex-col gap-0.5 rounded-xl border border-[#E4E4E4] bg-white p-1.5 shadow-[0_8px_24px_rgba(17,17,17,.12)]"
              data-shop-list
            >
              <span className="px-3 pb-1 pt-1.5 text-xs font-bold uppercase tracking-[.06em] text-[#5C5C5C]">{labels.shops}</span>
              {shops.map((s) => (
                <Link
                  key={s.slug}
                  href={switchTo(s.slug)}
                  onClick={onNavigate}
                  aria-current={s.slug === shop?.slug ? "true" : undefined}
                  className={`flex min-h-11 items-center rounded-lg px-3 text-base ${s.slug === shop?.slug ? "bg-[#F4F4F4] font-bold" : "font-semibold"}`}
                >
                  {s.name}
                </Link>
              ))}
              <Link href={`/${lang}/dashboard?new=1`} onClick={onNavigate} className="flex min-h-11 items-center rounded-lg px-3 text-base font-semibold">
                {labels.add_shop}
              </Link>
            </div>
          </details>
          {shop?.page && (
            <a
              href={shop.page}
              target="_blank"
              rel="noopener"
              aria-label={labels.view_page}
              title={labels.view_page}
              className="mx-3 flex h-[52px] flex-none items-center overflow-hidden rounded-xl border border-[#E4E4E4] text-base font-semibold text-[#111] outline-offset-[-2px] hover:bg-[#F4F4F4]"
              data-view-page
            >
              <span className={iconBox} data-nav-icon>
                <Icon d={NAV_ICONS.open} size={20} />
              </span>
              <span className="min-w-0 flex-1 truncate pr-2" data-nav-label>
                {labels.view_page}
              </span>
            </a>
          )}
        </div>
        <nav aria-label={labels.nav} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden pb-3">
          <span className="mx-3 flex h-8 flex-none items-end pb-1" aria-hidden="true">
            <span className="truncate pl-3.5 text-xs font-bold uppercase tracking-[.06em] text-[#5C5C5C]" data-nav-label>
              {labels.groups.main}
            </span>
          </span>
          {inGroup("main").map((m) => row(m, true))}
          {MENU_GROUPS.filter((g) => g !== "main").map((g) => (
            <div key={g} className="flex flex-col gap-0.5">
              {groupHead(g)}
              {groupList(g)}
            </div>
          ))}
        </nav>
      </>
    );
  };

  return (
    <>
      {/* phones and tablets (under 1024 px): the menu button on the left, then the page's name */}
      <div className="sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-[#E4E4E4] bg-white px-2.5 lg:hidden" data-owner-topbar>
        <button
          ref={opener}
          type="button"
          aria-label={labels.open_menu}
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          aria-controls="owner-panel"
          onClick={() => {
            panel.current?.showModal();
            setPanelOpen(true);
          }}
          className="flex size-12 flex-none items-center justify-center rounded-xl border border-[#E4E4E4]"
          data-owner-menu-button
        >
          <Icon d={NAV_ICONS.menu} />
        </button>
        <strong className="min-w-0 truncate text-lg">{current ? labelOf(current) : (shop?.name ?? "")}</strong>
      </div>
      <dialog
        ref={panel}
        id="owner-panel"
        aria-label={labels.nav}
        onClose={() => {
          setPanelOpen(false);
          opener.current?.focus();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) closePanel();
        }}
        className="ppi-owner-panel fixed inset-y-0 left-0 right-auto m-0 h-dvh max-h-none w-[min(320px,85vw)] max-w-none bg-white p-0 text-[#111] backdrop:bg-[#111]/40 lg:hidden"
        data-owner-panel
      >
        <div className="flex h-full flex-col">
          <div className="flex flex-none items-center justify-between gap-2 border-b border-[#E4E4E4] py-1 pl-[26px] pr-2">
            <strong className="text-base">{labels.nav}</strong>
            <button type="button" onClick={closePanel} aria-label={labels.close_menu} className="flex size-12 flex-none items-center justify-center rounded-xl" data-owner-panel-close>
              <Icon d={NAV_ICONS.close} />
            </button>
          </div>
          {body("panel")}
        </div>
      </dialog>

      {/* computers (1024 px and wider): open by default, "Zbaliť menu" collapses it to the 76 px rail */}
      <aside
        id="owner-menu"
        className="ppi-owner-aside sticky top-0 hidden h-svh flex-none flex-col overflow-hidden border-r border-[#E4E4E4] bg-white lg:flex"
        data-owner-nav={collapsed ? "collapsed" : "open"}
      >
        {body("aside")}
        <div className="flex-none border-t border-[#E4E4E4] py-2">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            aria-controls="owner-menu"
            aria-label={collapsed ? labels.expand_menu : labels.collapse_menu}
            title={collapsed ? labels.expand_menu : labels.collapse_menu}
            className="mx-3 flex h-12 w-[calc(100%-24px)] items-center overflow-hidden rounded-xl text-left text-[15px] font-semibold text-[#5C5C5C] outline-offset-[-2px] hover:bg-[#F4F4F4] hover:text-[#111]"
            data-nav-collapse
          >
            <span className={iconBox} data-nav-icon>
              <Icon d={NAV_ICONS.collapse} className={collapsed ? "rotate-180" : ""} />
            </span>
            <span className="min-w-0 flex-1 truncate pr-2" data-nav-label>
              {collapsed ? labels.expand_menu : labels.collapse_menu}
            </span>
          </button>
        </div>
      </aside>
    </>
  );
}
