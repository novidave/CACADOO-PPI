"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  isBareScreen,
  MENU_GROUPS,
  menuFor,
  menuHref,
  menuItemFor,
  OWNER_MENU,
  withoutLang,
  type MenuGroup,
  type MenuItem,
  type MenuKey,
  type ShopKind,
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
  /** The kind of shop (update 79): its menu (a restaurant: Menu and Objednávky jedla first, no stock-file pages). */
  kind: ShopKind;
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
export const NAV_BOOT = `try{if(localStorage.getItem("${NAV_STORAGE}")==="collapsed")document.documentElement.dataset.ownerNav="collapsed";if(localStorage.getItem("ppi.owner.ai")==="open")document.documentElement.dataset.ownerAi="open"}catch(e){}`;

/** Where the computer remembers the AI pomocník's panel (this device only; default closed). */
export const AI_STORAGE = "ppi.owner.ai";
const AI_EVENT = "ppi:owner-ai";
export const aiOpenNow = () => typeof document !== "undefined" && document.documentElement.dataset.ownerAi === "open";
export function subscribeAi(change: () => void) {
  window.addEventListener(AI_EVENT, change);
  return () => window.removeEventListener(AI_EVENT, change);
}
/** Opens or closes the AI pomocník's panel (computer); the choice is kept on this device. */
export function setAiOpen(on: boolean) {
  if (on) document.documentElement.dataset.ownerAi = "open";
  else delete document.documentElement.dataset.ownerAi;
  try {
    window.localStorage.setItem(AI_STORAGE, on ? "open" : "closed");
  } catch {
    // blocked storage: the choice lasts for this page only
  }
  window.dispatchEvent(new Event(AI_EVENT));
}

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

/** The AI pomocník panel's question box (after the owner opened the panel). */
function focusAiBox() {
  const box = document.querySelector("[data-ai-panel] textarea");
  if (box instanceof HTMLTextAreaElement) box.focus();
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

/**
 * Every row is 52 px high and its icon sits in the same 52 px square, 12 px from the menu's edge (the icon's centre at
 * 38 px), open or collapsed; collapsed, the row itself is that square (globals.css `[data-nav-cell]`).
 */
const iconBox = "flex h-[52px] w-[52px] flex-none items-center justify-center";
const cell = "relative mx-3 flex h-[52px] flex-none items-center overflow-hidden rounded-xl outline-offset-[-2px]";

/**
 * The owner menu (back-end layout, 2026-11-03; open by default and collapsible since 2026-11-04):
 * - 1024 px and wider: the 256 px menu beside the page, OPEN on every page (also Predaj, the Príjemka editor,
 *   Inventúra counting and the food board). "Zbaliť menu" at its bottom collapses it to a 76 px rail and back,
 *   remembered on this device (localStorage `ppi.owner.nav`). The rows are the same in both states — the shop switcher
 *   (56 px), "Zobraziť moju stránku" (52 px), "Hlavné" (52 px rows), the group heads and rows (46 px) — and every icon
 *   sits in the same 52 px box of a fixed 76 px column, so collapsing only hides the labels (badges move to the icon's
 *   corner) and no icon moves. Only the width is animated (nothing with `prefers-reduced-motion`).
 * - under 1024 px (phones and tablets): a top bar with the 48 px menu button on the LEFT and the page's name; the
 *   SAME button opens and closes the menu (☰ ↔ ✕, `aria-expanded`), which slides in from the left UNDER the top bar
 *   (≤ 320 px or 85 % of the width, the page dimmed and inert), so the button never moves and is never covered; Esc or
 *   a tap outside also closes it and the focus goes back to the button.
 * - "AI pomocník" (2026-11-04, when the server has the AI key): on a computer a switch in the menu (`aria-pressed`, a
 *   square in the rail too) that opens the chat panel on the right (AssistantPanel); on a phone or a tablet an item of
 *   the menu that opens its own page /dashboard/pomocnik.
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
  const kind: ShopKind = shop?.kind ?? "goods";
  const current = menuItemFor(path, at, kind);

  // only one group open: the one holding the page, until the owner opens the other one (or closes it) on this page
  const holding: MenuGroup = current?.group === "account" ? "account" : "page";
  const [choice, setChoice] = useState<{ on: string; open: MenuGroup | null } | null>(null);
  const open = choice?.on === pathname ? choice.open : holding;
  const toggle = (group: MenuGroup) => setChoice({ on: pathname, open: open === group ? null : group });

  const collapsed = useSyncExternalStore(subscribe, collapsedNow, () => false);
  const aiOpen = useSyncExternalStore(subscribeAi, aiOpenNow, () => false);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  // the open phone menu: focus inside, Esc closes (focus back to the button), the page behind inert and not scrolling
  useEffect(() => {
    if (!panelOpen) return;
    const behind = [...document.querySelectorAll<HTMLElement>("[data-owner-page], [data-site-footer], .ppi-ai-panel")];
    for (const el of behind) el.inert = true;
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>("a[href], button, summary")?.focus();
    const onKey = (e: KeyboardEvent) => {
      // an Esc the shop switcher already used (it closed itself) leaves the panel open
      if (e.key === "Escape" && !e.defaultPrevented) {
        setPanelOpen(false);
        opener.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      for (const el of behind) el.inert = false;
      html.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [panelOpen]);

  // the shop switcher (a <details>): a tap outside closes it (the menu is not drawn again on navigation, so it would
  // otherwise stay open)
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      for (const d of document.querySelectorAll<HTMLDetailsElement>("details[data-shop-switcher][open]")) {
        if (!d.contains(e.target as Node)) d.open = false;
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  if (isBareScreen(path)) return null;

  const byKey = new Map(items.map((i) => [i.key, i]));
  // update 79: the menu of this kind of shop (a restaurant: Menu and Objednávky jedla first, no stock-file pages)
  const shown = menuFor(kind).filter((m) => byKey.has(m.key));
  const inGroup = (g: MenuGroup) => shown.filter((m) => m.group === g);
  const labelOf = (m: MenuItem) => byKey.get(m.key)?.label ?? m.key;
  const badgeOf = (m: MenuItem) => (shop ? (byKey.get(m.key)?.badges?.[shop.slug] ?? 0) : 0);
  const ariaOf = (m: MenuItem) => {
    const n = badgeOf(m);
    const view = byKey.get(m.key);
    return n > 0 && view?.badgeLabel ? `${labelOf(m)}, ${view.badgeLabel.replace("{n}", String(n))}` : labelOf(m);
  };
  const hrefOf = (m: MenuItem) => menuHref(m, lang, shopParam || null, kind);
  const switchTo = (slug: string) =>
    menuHref(current ?? OWNER_MENU.find((m) => m.key === "shop")!, lang, slug, shops.find((s) => s.slug === slug)?.kind);
  const closePanel = () => setPanelOpen(false);
  // opened by the owner: straight into the question box of the panel
  const toggleAi = (on: boolean) => {
    setAiOpen(on);
    if (on) window.setTimeout(focusAiBox, 0);
  };
  const aiItem = byKey.get("pomocnik");

  /** The menu itself — the same rows beside the page (`aside`) and in the phone's panel (`panel`). */
  const body = (where: "aside" | "panel") => {
    const inPanel = where === "panel";
    const attr = inPanel ? "data-panel-item" : "data-nav-item";
    const onNavigate = inPanel ? closePanel : undefined;
    // picking a shop (or "Pridať obchod") closes the switcher, then whatever the menu's other links do
    const onPick = (e: ReactMouseEvent<HTMLElement>) => {
      const box = e.currentTarget.closest("details");
      if (box) box.open = false;
      onNavigate?.();
    };
    // Esc closes the open switcher first (the phone panel stays open), the focus back on it
    const onSwitcherKey = (e: ReactKeyboardEvent<HTMLDetailsElement>) => {
      if (e.key !== "Escape" || !e.currentTarget.open) return;
      e.preventDefault();
      e.currentTarget.open = false;
      e.currentTarget.querySelector("summary")?.focus();
    };
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
          className={`ppi-nav-row ${cell} ${big ? "text-[17px]" : "text-base"} ${
            on ? "bg-[#111] font-bold text-white" : "font-semibold text-[#111] hover:bg-[#F4F4F4]"
          }`}
          data-nav-cell
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
    // a group's head: a thin line above it, then its own 52 px row (a square in the rail, the name as its title)
    const groupHead = (g: MenuGroup) => (
      <button
        type="button"
        onClick={() => toggle(g)}
        aria-expanded={open === g}
        aria-controls={`owner-${where}-${g}`}
        aria-label={labels.groups[g]}
        title={labels.groups[g]}
        data-nav-group={g}
        data-nav-cell
        className={`${cell} text-[#5C5C5C] hover:bg-[#F4F4F4] hover:text-[#111]`}
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
      <div id={`owner-${where}-${g}`} className={`flex flex-col gap-1 ${open === g ? "" : "hidden"}`} data-nav-list={g}>
        {inGroup(g).map((m) => row(m, false))}
        {g === "account" && (
          <form action="/auth/signout" method="post" className="contents">
            <button
              type="submit"
              title={labels.sign_out}
              aria-label={labels.sign_out}
              className={`ppi-nav-row ${cell} text-left text-base font-semibold text-[#111] hover:bg-[#F4F4F4]`}
              data-nav-cell
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
          <details className="group relative" data-shop-switcher onKeyDown={onSwitcherKey}>
            <summary
              aria-label={`${labels.shop}: ${shop?.name ?? ""}`}
              title={shop?.name ?? ""}
              className={`${cell} cursor-pointer list-none border border-[#E4E4E4] [&::-webkit-details-marker]:hidden`}
              data-nav-cell
            >
              <span className={`${iconBox} -m-px`} data-nav-icon>
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
                  onClick={onPick}
                  aria-current={s.slug === shop?.slug ? "true" : undefined}
                  className={`flex min-h-11 items-center rounded-lg px-3 text-base ${s.slug === shop?.slug ? "bg-[#F4F4F4] font-bold" : "font-semibold"}`}
                >
                  {s.name}
                </Link>
              ))}
              <Link href={`/${lang}/dashboard?new=1`} onClick={onPick} className="flex min-h-11 items-center rounded-lg px-3 text-base font-semibold">
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
              className={`${cell} border border-[#E4E4E4] text-base font-semibold text-[#111] hover:bg-[#F4F4F4]`}
              data-nav-cell
              data-view-page
            >
              <span className={`${iconBox} -m-px`} data-nav-icon>
                <Icon d={NAV_ICONS.open} size={20} />
              </span>
              <span className="min-w-0 flex-1 truncate pr-2" data-nav-label>
                {labels.view_page}
              </span>
            </a>
          )}
        </div>
        <nav aria-label={labels.nav} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden pb-3">
          <span className="mx-3 flex h-8 flex-none items-end pb-1" aria-hidden="true">
            <span className="truncate pl-3.5 text-xs font-bold uppercase tracking-[.06em] text-[#5C5C5C]" data-nav-label>
              {labels.groups.main}
            </span>
          </span>
          {inGroup("main").filter((m) => m.key !== "pomocnik" || inPanel).map((m) => row(m, true))}
          {!inPanel && aiItem && (
            <button
              type="button"
              onClick={() => toggleAi(!aiOpen)}
              aria-pressed={aiOpen}
              aria-label={aiItem.label}
              title={aiItem.label}
              className={`ppi-nav-row ${cell} text-left text-[17px] ${aiOpen ? "bg-[#111] font-bold text-white" : "font-semibold text-[#111] hover:bg-[#F4F4F4]"}`}
              data-nav-cell
              data-ai-toggle
            >
              <span className={iconBox} data-nav-icon>
                <Icon d={NAV_ICONS.pomocnik} />
              </span>
              <span className="min-w-0 flex-1 truncate pr-2" data-nav-label>
                {aiItem.label}
              </span>
            </button>
          )}
          {MENU_GROUPS.filter((g) => g !== "main").map((g) => (
            <div key={g} className="flex flex-col gap-1">
              <div className="mx-3 mt-1.5 h-px flex-none bg-[#E4E4E4]" aria-hidden="true" />
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
      {/* phones and tablets (under 1024 px): ONE menu button on the left (it opens and closes the menu), then the page's name */}
      <div className="sticky top-0 z-50 flex h-14 items-center gap-2 border-b border-[#E4E4E4] bg-white px-2.5 lg:hidden" data-owner-topbar>
        <button
          ref={opener}
          type="button"
          aria-label={panelOpen ? labels.close_menu : labels.open_menu}
          aria-expanded={panelOpen}
          aria-controls="owner-panel"
          onClick={() => setPanelOpen(!panelOpen)}
          className="flex size-12 flex-none items-center justify-center rounded-xl border border-[#E4E4E4]"
          data-owner-menu-button
        >
          <Icon d={panelOpen ? NAV_ICONS.close : NAV_ICONS.menu} />
        </button>
        <strong className="min-w-0 truncate text-lg">{current ? labelOf(current) : (shop?.name ?? "")}</strong>
      </div>
      {panelOpen && <div className="fixed inset-x-0 bottom-0 top-14 z-40 bg-[#111]/40 lg:hidden" onClick={closePanel} aria-hidden="true" data-owner-panel-backdrop />}
      <div
        ref={panel}
        id="owner-panel"
        role="region"
        aria-label={labels.nav}
        hidden={!panelOpen}
        data-open={panelOpen || undefined}
        className="ppi-owner-panel fixed left-0 z-40 flex w-[min(320px,85vw)] flex-col overflow-hidden bg-white text-[#111] shadow-[8px_0_24px_rgba(17,17,17,.12)] lg:hidden"
        data-owner-panel
      >
        {body("panel")}
      </div>

      {/* computers (1024 px and wider): open by default, "Zbaliť menu" collapses it to the 76 px rail */}
      <aside
        id="owner-menu"
        className="ppi-owner-aside sticky top-0 hidden h-svh flex-none flex-col overflow-hidden bg-white lg:flex"
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
            className={`${cell} w-[calc(100%-24px)] text-left text-[15px] font-semibold text-[#5C5C5C] hover:bg-[#F4F4F4] hover:text-[#111]`}
            data-nav-cell
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
