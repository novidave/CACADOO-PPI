import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import type { MyShop } from "@/lib/myShops";
import { SkladScanner } from "@/components/SkladScanner";
import { chooseShop } from "../contacts/parts";
import { hiddenFields, ShopSwitcher } from "../shared";

export const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SkladTab = "overview" | "products" | "movements" | "settings";
export type SkladTexts = Dictionary["sklad"];

/** The page's language, texts, login and the shop chosen (?shop=); the owner_sklad_* functions decide what may happen. */
export async function loadSklad(langValue: string, sp: Record<string, string | string[] | undefined>) {
  if (!isLocale(langValue)) notFound();
  const lang: Locale = langValue;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const chosen = await chooseShop(session.supabase, first(sp.shop));
  if (chosen.error) return { ok: false as const, lang, dict, s: dict.sklad, error: chosen.error };
  if (!chosen.shop) redirect(`/${lang}/dashboard`);
  const shop = chosen.shop;
  const base = `/${lang}/dashboard/sklad`;
  const href = (path = "", query: Record<string, string> = {}) =>
    `${base}${path}?${new URLSearchParams({ shop: shop.slug, ...query })}`;
  return { ok: true as const, lang, dict, s: dict.sklad, session, error: null, shops: chosen.shops, shop, hidden: hiddenFields(lang, shop), href };
}

/** The status line and messages from ?ok= / ?err= (the actions' redirects). */
export function Notice({ s, ok, err }: { s: SkladTexts; ok?: string; err?: string }) {
  const texts = s as Record<string, string>;
  if (ok && texts[`ok_${ok}`]) {
    return (
      <p role="status" className="rounded-xl border border-foreground p-3 font-medium" data-sklad-ok={ok}>
        {texts[`ok_${ok}`]}
      </p>
    );
  }
  if (err) {
    return (
      <p role="alert" className="rounded-xl border border-foreground p-3 font-medium" data-sklad-err={err}>
        {texts[`err_${err}`] ?? s.err_failed}
      </p>
    );
  }
  return null;
}

/**
 * Môj obchod → Sklad: the title, the shop switcher, the tab row (Prehľad · Produkty · Pohyby · Nastavenia; Predaj,
 * Príjemky and Inventúra come with their phases), the scanner (a USB scanner anywhere on these pages, "Skenovať" with
 * the camera) and, while Sklad is not the shop's stock source, a line that says so.
 */
export function SkladShell({
  lang,
  s,
  shops,
  shop,
  current,
  source,
  dict,
  children,
}: {
  lang: Locale;
  s: SkladTexts;
  shops: MyShop[];
  shop: MyShop;
  current: SkladTab;
  source: string | null;
  dict: Dictionary;
  children: ReactNode;
}) {
  const base = `/${lang}/dashboard/sklad`;
  const q = `?${new URLSearchParams({ shop: shop.slug })}`;
  const tabs: { key: SkladTab; href: string; label: string }[] = [
    { key: "overview", href: `${base}${q}`, label: s.tab_overview },
    { key: "products", href: `${base}/products${q}`, label: s.tab_products },
    { key: "movements", href: `${base}/movements${q}`, label: s.tab_movements },
    { key: "settings", href: `${base}/settings${q}`, label: s.tab_settings },
  ];
  return (
    <div className="flex max-w-5xl flex-col gap-4" data-sklad={current}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[26px] font-bold">{s.title}</h1>
        <SkladScanner
          scanUrl={`${base}/scan`}
          shop={shop.slug}
          labels={{
            scan: s.scan,
            title: s.scan_title,
            hint: s.scan_hint,
            close: s.scan_close,
            torch: s.scan_torch,
            manual: s.scan_manual,
            manual_go: s.scan_manual_go,
            no_camera: s.scan_no_camera,
            loading: s.scan_loading,
            found: s.scan_found,
          }}
        />
      </div>
      <ShopSwitcher shops={shops} current={shop} label={dict.dashboard.shop} href={(slug) => `${base}${current === "overview" ? "" : `/${current}`}?shop=${slug}`} />
      {shops.length > 1 && <p className="text-muted">{shop.name}</p>}
      <nav aria-label={s.tabs_label} className="flex gap-5 overflow-x-auto whitespace-nowrap border-b border-line">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={t.key === current ? "page" : undefined}
            className={`flex min-h-11 flex-none items-center border-b-2 px-0.5 text-[15px] font-semibold ${
              t.key === current ? "border-foreground text-foreground" : "border-transparent text-muted"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {source && source !== "sklad" && current !== "settings" && (
        <p className="rounded-xl border border-line bg-[#F7F7F7] p-3 text-sm" data-sklad-not-source>
          {s.not_source}{" "}
          <Link href={`${base}/settings${q}#source`} className="font-semibold underline underline-offset-4">
            {s.not_source_link}
          </Link>
        </p>
      )}
      {children}
    </div>
  );
}

/** The plan counter ("Free · 38 z 50 produktov" + bar), or "Pro: neobmedzený počet produktov". */
export function PlanCounter({ s, products, limit, planHref }: { s: SkladTexts; products: number; limit: number | null; planHref: string }) {
  if (limit === null) return <p className="text-sm text-muted">{s.plan_pro}</p>;
  const pct = Math.min(100, Math.round((products / Math.max(limit, 1)) * 100));
  return (
    <div className="flex flex-col gap-2" data-sklad-plan={`${products}/${limit}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong className="text-[15px]">{s.plan_free.replace("{n}", String(products)).replace("{limit}", String(limit))}</strong>
        <Link href={planHref} className="text-sm font-semibold underline underline-offset-4">
          {s.plan_go_pro}
        </Link>
      </div>
      <div aria-hidden="true" className="h-2 rounded bg-[#EDEDED]">
        <div className="h-2 rounded bg-foreground" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[13px] text-muted">{s.plan_pro}</span>
    </div>
  );
}

export const btn = "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-foreground bg-foreground px-4 text-[15px] font-bold text-white";
export const btnGhost = "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-[#D6D6D6] bg-white px-4 text-[15px] font-bold text-foreground";
export const card = "flex flex-col gap-3 rounded-xl border border-line p-4";
