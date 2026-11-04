import Link from "next/link";
import type { Dictionary } from "@/i18n/dictionaries";
import { t } from "@/i18n/dictionaries";
import type { FoodOrder, FoodOrders, OpenState } from "@/lib/foodOwner";
import { money, nextSteps, plural, type OrderStatus } from "@/lib/foodRules";
import { orderStep as stepAction, pauseOrders } from "./actions";
import { buttonClass, ghostClass } from "@/components/owner/ui";
import { itemTabs, PageHead } from "@/components/owner/PageHead";
import type { MyShop } from "@/lib/myShops";
import { ShopSwitcher } from "../../shared";

/** Shared parts of Asistent → Objednávky (boards 11–13): the state strip, an order card, the notices, small helpers. */

// back-end layout L3: the shared 52 px buttons (@/components/owner/ui)
export const btn = buttonClass;
export const btnGhost = ghostClass;
export const btnOrange = "inline-flex min-h-11 items-center justify-center rounded-lg bg-[#F57C20] px-4 font-semibold text-white";

export const hhmm = (iso: string | null | undefined, timeZone: string) =>
  iso ? new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)) : "";

/** "pred 2 min" / "práve teraz" (the page draws it; the list reads itself again every 10 s). */
export function ago(f: Dictionary["food"], iso: string): string {
  const min = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  return min < 1 ? f.just_now : t(f.ago, { n: min });
}

/** The status in words (st_*). */
export const statusText = (f: Dictionary["food"], s: OrderStatus) => (f as Record<string, string>)[`st_${s}`] ?? s;
/** The payment method in words. */
export const payText = (f: Dictionary["food"], m: string) => (f as Record<string, string>)[`pay_${m}`] ?? m;

/** The main next step of an order (the first allowed step that is not a cancel), with its button text. */
export function mainStep(f: Dictionary["food"], o: Pick<FoodOrder, "kind" | "status">): { to: OrderStatus; label: string } | null {
  const to = nextSteps(o.kind, o.status).find((s) => s !== "cancelled");
  if (!to) return null;
  const labels = f as Record<string, string>;
  return { to, label: labels[`to_${to}`] ?? to };
}

/** "Prijímame objednávky · Odber 20 min · donáška 45 min · do 21:30" + "Pozastaviť" / "Spustiť objednávky". */
export function StateStrip({
  f,
  state,
  settings,
  timeZone,
  hidden,
  canWrite,
  sound,
}: {
  f: Dictionary["food"];
  state: OpenState;
  settings: FoodOrders["settings"];
  timeZone: string;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  canWrite: boolean;
  sound?: React.ReactNode;
}) {
  const labels = f as Record<string, string>;
  const parts = [
    settings?.pickup_on ? t(f.times_pickup, { n: settings.prep_minutes }) : null,
    settings?.delivery_on ? t(f.times_delivery, { n: settings.delivery_minutes }) : null,
    state.last_order_at ? t(f.times_until, { time: hhmm(state.last_order_at, timeZone) }) : null,
  ].filter(Boolean);
  const paused = Boolean(settings?.paused);
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 ${state.accepting ? "border-[#1E9E5A] bg-[#F1FBF5]" : "border-line"}`}
      data-food-state={state.accepting ? "accepting" : state.reason ?? "off"}
    >
      <div className="flex min-w-0 flex-col">
        <span className="flex items-center gap-2 font-bold">
          <span
            aria-hidden="true"
            className={`inline-block size-3 flex-none rounded-full ring-2 ring-white ring-offset-1 ${state.accepting ? "bg-[#1E9E5A] ring-offset-[#146C37]" : paused ? "bg-[#F2B705] ring-offset-[#B7860B]" : "bg-[#D64545] ring-offset-[#9B2C2C]"}`}
          />
          {state.accepting ? f.accepting : labels[`not_accepting_${state.reason ?? "off"}`] ?? f.not_accepting_off}
        </span>
        {parts.length > 0 && <span className="text-sm text-muted">{parts.join(" · ")}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {sound}
        {canWrite && settings?.enabled && (
          <form action={pauseOrders}>
            {hidden({ paused: paused ? "0" : "1" })}
            <button type="submit" className={paused ? btn : btnGhost} data-food-pause={paused ? "resume" : "pause"}>
              {paused ? f.resume : f.pause}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/** One order as a card (board 11): number, name, total, times, items, how and how paid, the main step and "Detail". */
export function OrderCard({
  f,
  o,
  lang,
  detailHref,
  hidden,
  stepId,
  canWrite,
  compact = false,
}: {
  f: Dictionary["food"];
  o: FoodOrder;
  lang: string;
  detailHref: string;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  stepId: string;
  canWrite: boolean;
  compact?: boolean;
}) {
  const tz = o.timezone;
  const items = o.lines
    .map((l) => `${l.qty}× ${l.name}${l.extras_text ? ` (${l.extras_text})` : ""}`)
    .join(", ");
  const when = o.kind === "delivery" ? t(f.deliver_by, { time: hhmm(o.ready_by, tz) }) : t(f.pickup_at, { time: hhmm(o.ready_by, tz) });
  const isNew = o.status === "new";
  return (
    <article
      className={`flex flex-col gap-2 rounded-xl border bg-white p-3.5 ${isNew ? "border-[#F57C20]" : "border-line"}`}
      data-food-order={o.number}
      data-status={o.status}
    >
      <div className="flex items-baseline justify-between gap-3">
        <Link href={detailHref} className="min-w-0 truncate text-[17px] font-bold">
          #{o.number}
          {o.name ? ` · ${o.name}` : ""}
        </Link>
        <strong className="flex-none text-[17px] tabular-nums">{money(o.total_cents, lang, o.currency)}</strong>
      </div>
      <p className="text-sm text-muted">
        {hhmm(o.created_at, tz)}
        {isNew ? ` · ${ago(f, o.created_at)}` : ""} · {when}
      </p>
      {!compact ? (
        <p className="text-[15px]">{items}</p>
      ) : (
        <p className="text-sm text-muted">{plural(o.lines.reduce((n, l) => n + l.qty, 0), { one: f.items_one, few: f.items_few, many: f.items_many }, lang)}</p>
      )}
      <ul className="flex flex-wrap gap-1.5 text-xs font-semibold">
        <li className="rounded-full bg-[#EEF1F5] px-2.5 py-1">
          {o.kind === "delivery" ? `${f.kind_delivery}${o.address && !compact ? ` · ${o.address.split(",")[0]}` : ""}` : f.kind_pickup}
        </li>
        <li className="rounded-full bg-[#EEF1F5] px-2.5 py-1">
          {o.paid_at ? t(f.paid_short, { method: payText(f, o.pay_method) }) : o.cash_given_cents && o.pay_method === "cash"
            ? t(f.cash_from, { amount: money(o.cash_given_cents, lang) })
            : payText(f, o.pay_method)}
        </li>
        {o.verified && <li className="rounded-full bg-[#DCF5E5] px-2.5 py-1 text-[#146C37]">{f.verified}</li>}
        {/* update 75: the courier, and a problem the courier reported */}
        {o.courier_name && <li className="rounded-full border border-[#D6D6D6] px-2.5 py-1" data-order-courier-chip>{t(f.cr_by, { name: o.courier_name })}</li>}
        {o.problem && <li className="rounded-full border border-[#D64545] px-2.5 py-1 text-[#B42318]" data-order-problem-chip>{t(f.cr_problem, { reason: o.problem })}</li>}
      </ul>
      <StepRow f={f} o={o} detailHref={detailHref} hidden={hidden} stepId={stepId} canWrite={canWrite} />
    </article>
  );
}

/** The card's buttons: the main step (a delivered / picked-up step and a payment are on the detail page) and "Detail". */
function StepRow({
  f,
  o,
  detailHref,
  hidden,
  stepId,
  canWrite,
}: {
  f: Dictionary["food"];
  o: FoodOrder;
  detailHref: string;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  stepId: string;
  canWrite: boolean;
}) {
  const step = mainStep(f, o);
  const finishing = step && (step.to === "delivered" || step.to === "picked_up");
  return (
    <div className="flex gap-2">
      {canWrite && step && !finishing && (
        <StepForm hidden={hidden} order={o.id} to={step.to} stepId={stepId} className={`${o.status === "new" ? btnOrange : btn} flex-1`}>
          {step.label}
        </StepForm>
      )}
      <Link href={detailHref} className={`${btnGhost} ${canWrite && step && !finishing ? "" : "flex-1"}`}>
        {finishing && o.paid_at === null ? f.pay_and_finish : f.detail}
      </Link>
    </div>
  );
}

/** One step as a form (its own step UUID, made when the page was drawn: a double tap is the same step). */
export function StepForm({
  hidden,
  order,
  to,
  stepId,
  className,
  extra = {},
  children,
}: {
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  order: string;
  to: OrderStatus | "";
  stepId: string;
  className: string;
  extra?: Record<string, string>;
  children: React.ReactNode;
}) {
  return (
    <form action={stepAction} className="contents">
      {hidden({ order_id: order, to, step_id: stepId, ...extra })}
      <button type="submit" className={className} data-food-step={to}>
        {children}
      </button>
    </form>
  );
}


/** The page's notice after a form came back (?ok= / ?err=). */
export function FoodNotice({ f, ok, err }: { f: Dictionary["food"]; ok?: string; err?: string }) {
  const texts = f as Record<string, string>;
  if (err) return <p role="alert" className="rounded-lg border border-[#D64545] p-3">{texts[err] ?? f.err_failed}</p>;
  if (ok) return <p role="status" className="rounded-lg border border-foreground p-3 font-medium">{texts[ok] ?? f.ok_status}</p>;
  return null;
}

/**
 * Objednávky jedla's head on every tab and on an order's page (back-end layout, one place for the tabs): the title,
 * the shop switcher and Objednávky · Kuriéri · Menu · Nastavenia with the number of new orders — the same block
 * everywhere, so a tab never moves it. The state strip, "Pozastaviť", the filters and the board go under it.
 */
export function FoodHead({
  dict,
  lang,
  shops,
  shop,
  current,
  newOrders,
  switchHref,
}: {
  dict: Dictionary;
  lang: string;
  shops: MyShop[];
  shop: MyShop;
  current: "orders" | "couriers" | "menu" | "settings";
  newOrders: number;
  switchHref: (slug: string) => string;
}) {
  const tabs = itemTabs(dict, lang, "food", shop.slug, { orders: newOrders }).map((x) =>
    x.key === "orders" && newOrders > 0 ? { ...x, badgeLabel: t(dict.food.tab_badge, { n: newOrders }) } : x,
  );
  return (
    <PageHead title={dict.nav.food} item="food" tabs={tabs} current={current} tabsLabel={dict.nav.tabs_label}>
      <ShopSwitcher shops={shops} current={shop} label={dict.dashboard.shop} href={switchHref} />
      {shops.length > 1 && <p className="text-muted">{shop.name}</p>}
    </PageHead>
  );
}
