import Link from "next/link";
import type { Dictionary } from "@/i18n/dictionaries";
import { t } from "@/i18n/dictionaries";
import type { FoodOrder } from "@/lib/foodOwner";
import { money, nextSteps, plural, type OrderStatus } from "@/lib/foodRules";
import { orderStep as stepAction } from "./actions";
import { buttonClass, ghostClass } from "@/components/owner/ui";
import { itemTabs, PageHead } from "@/components/owner/PageHead";
import type { MyShop } from "@/lib/myShops";
import { ShopSwitcher } from "../../shared";

/** Shared parts of Objednávky jedla (boards 11–13): an order card, the notices, the head, small helpers (the green bar is @/components/owner/FoodBar). */

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
/** The payment method in words (update 81: none when the shop takes no payments in Cacaduu). */
export const payText = (f: Dictionary["food"], m: string | null) => (m ? ((f as Record<string, string>)[`pay_${m}`] ?? m) : "");

/** The main next step of an order (the first allowed step that is not a cancel), with its button text. */
export function mainStep(f: Dictionary["food"], o: Pick<FoodOrder, "kind" | "status">): { to: OrderStatus; label: string } | null {
  const to = nextSteps(o.kind, o.status).find((s) => s !== "cancelled");
  if (!to) return null;
  const labels = f as Record<string, string>;
  return { to, label: labels[`to_${to}`] ?? to };
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
  payments = true,
  finish,
}: {
  f: Dictionary["food"];
  o: FoodOrder;
  lang: string;
  detailHref: string;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  stepId: string;
  canWrite: boolean;
  compact?: boolean;
  /** update 81: "Platby v Cacaduu" — off = no pay chip */
  payments?: boolean;
  /** 2026-11-07: the finishing step's button (@/components/owner/FoodFinish: the payment / courier dialog first) */
  finish?: React.ReactNode;
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
        {/* update 87: the delivery zone the customer picked */}
        {o.kind === "delivery" && o.zone_name && (
          <li className="rounded-full bg-[#EEF1F5] px-2.5 py-1" data-food-zone>
            {o.zone_name}
          </li>
        )}
        {payments && o.pay_method && (
          <li className="rounded-full bg-[#EEF1F5] px-2.5 py-1">
            {o.paid_at ? t(f.paid_short, { method: payText(f, o.pay_method) }) : o.cash_given_cents && o.pay_method === "cash"
              ? t(f.cash_from, { amount: money(o.cash_given_cents, lang) })
              : payText(f, o.pay_method)}
          </li>
        )}
        {o.verified && <li className="rounded-full bg-[#DCF5E5] px-2.5 py-1 text-[#146C37]">{f.verified}</li>}
        {/* update 75: the courier, and a problem the courier reported */}
        {o.courier_name && <li className="rounded-full border border-[#D6D6D6] px-2.5 py-1" data-order-courier-chip>{t(f.cr_by, { name: o.courier_name })}</li>}
        {o.problem && <li className="rounded-full border border-[#D64545] px-2.5 py-1 text-[#B42318]" data-order-problem-chip>{t(f.cr_problem, { reason: o.problem })}</li>}
      </ul>
      <StepRow f={f} o={o} detailHref={detailHref} hidden={hidden} stepId={stepId} canWrite={canWrite} finish={finish} />
    </article>
  );
}

/**
 * The card's buttons: the main step and "Detail". A delivered / picked-up step is the board's finish button (the payment
 * dialog first, 2026-11-07) when the page gives one, else it is on the order's page.
 */
function StepRow({
  f,
  o,
  detailHref,
  hidden,
  stepId,
  canWrite,
  finish,
}: {
  f: Dictionary["food"];
  o: FoodOrder;
  detailHref: string;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  stepId: string;
  canWrite: boolean;
  finish?: React.ReactNode;
}) {
  const step = mainStep(f, o);
  const finishing = step && (step.to === "delivered" || step.to === "picked_up");
  if (canWrite && finishing && finish) {
    return (
      <div className="flex gap-2">
        {finish}
        <Link href={detailHref} className={btnGhost}>
          {f.detail}
        </Link>
      </div>
    );
  }
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
  couriers = true,
}: {
  dict: Dictionary;
  lang: string;
  shops: MyShop[];
  shop: MyShop;
  current: "orders" | "couriers" | "menu" | "settings";
  newOrders: number;
  switchHref: (slug: string) => string;
  /** update 81: the Kuriéri tab only with the courier app (owner_food_tab().parts) */
  couriers?: boolean;
}) {
  const tabs = itemTabs(dict, lang, "food", shop.slug, { orders: newOrders })
    .filter((x) => couriers || x.key !== "couriers")
    .map((x) => (x.key === "orders" && newOrders > 0 ? { ...x, badgeLabel: t(dict.food.tab_badge, { n: newOrders }) } : x));
  return (
    <PageHead title={dict.nav.food} item="food" tabs={tabs} current={current} tabsLabel={dict.nav.tabs_label}>
      <ShopSwitcher shops={shops} current={shop} label={dict.dashboard.shop} href={switchHref} />
    </PageHead>
  );
}
