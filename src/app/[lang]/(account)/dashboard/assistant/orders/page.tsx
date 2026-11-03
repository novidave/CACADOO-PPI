import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { foodTab, type FoodOrder, type FoodOrders } from "@/lib/foodOwner";
import { money } from "@/lib/foodRules";
import { DbError } from "@/components/DbError";
import { FoodOrdersLive } from "@/components/FoodOrdersLive";
import { AssistantTabs, waitingCount } from "../../AssistantTabs";
import { chooseShop } from "../../contacts/parts";
import { hiddenFields, ProOnly, ShopSwitcher } from "../../shared";
import { FoodNotice, OrderCard, StateStrip } from "./parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/assistant/orders">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).food.title };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const FILTERS = ["new", "preparing", "on_the_way", "done"] as const;
type Filter = (typeof FILTERS)[number];

/**
 * Asistent → Objednávky (boards 11 and 13, database updates 73–74): the state ("Prijímame objednávky · Odber 20 min ·
 * donáška 45 min · do 21:30", "Pozastaviť"), then on a phone the filters Nové · V príprave · Na ceste · Hotové with
 * their counts and the cards, and on a computer the kitchen board — four columns (Nové, V príprave, Na ceste / na odber,
 * Doručené with today's totals). Each card's main step is one form with its own step UUID; paying and finishing are on
 * the order's page. The page reads itself again when a new order comes (FoodOrdersLive, every 10 s, with the Cacaduu sound).
 * Every rule is in SQL (owner_food_orders: members; steps: owner_food_order_status, the plan).
 */
export default async function OrdersPage({ params, searchParams }: PageProps<"/[lang]/dashboard/assistant/orders">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const f = dict.food;
  const chosen = await chooseShop(supabase, first(sp.shop));
  if (chosen.error) return <DbError message={chosen.error} dict={dict} />;
  const shop = chosen.shop;
  if (!shop) redirect(`/${lang}/dashboard`);
  const filter: Filter = (FILTERS as readonly string[]).includes(first(sp.f) ?? "") ? (first(sp.f) as Filter) : "new";

  const [plan, openRes, doneRes, waiting, tab] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    supabase.rpc("owner_food_orders", { p_shop_id: shop.id, p_filter: "open", p_limit: 200 }),
    supabase.rpc("owner_food_orders", { p_shop_id: shop.id, p_filter: "done", p_limit: 100 }),
    waitingCount(supabase, shop.id),
    foodTab(supabase, shop.id),
  ]);
  if (openRes.error) return <DbError message={openRes.error.message} dict={dict} />;
  const hasPlan = !plan.error && plan.data === true;
  const open = openRes.data as FoodOrders;
  const done = (doneRes.data ?? null) as FoodOrders | null;
  const hidden = hiddenFields(lang, shop);
  const settings = open.settings;
  const enabled = Boolean(settings?.enabled);
  const tz = open.timezone;
  const settingsHref = `/${lang}/dashboard/assistant/orders/settings?shop=${shop.slug}`;
  const detail = (o: FoodOrder) => `/${lang}/dashboard/assistant/orders/${o.id}?shop=${shop.slug}`;
  const listHref = (fv: Filter) => `/${lang}/dashboard/assistant/orders?${new URLSearchParams({ shop: shop.slug, f: fv })}`;
  const byStatus = (s: FoodOrder["status"][]) => open.orders.filter((o) => s.includes(o.status)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const columns: { key: Filter; title: string; rows: FoodOrder[] }[] = [
    { key: "new", title: f.f_new, rows: byStatus(["new"]) },
    { key: "preparing", title: f.f_preparing, rows: byStatus(["preparing"]) },
    { key: "on_the_way", title: f.col_on_the_way, rows: byStatus(["on_the_way", "ready"]) },
  ];
  const counts = { ...open.counts, done: done?.counts.done ?? open.counts.done };
  const shown: FoodOrder[] =
    filter === "done" ? (done?.orders ?? []) : filter === "on_the_way" ? byStatus(["on_the_way", "ready"]) : byStatus([filter]);
  const card = (o: FoodOrder, compact = false) => (
    <OrderCard key={o.id} f={f} o={o} lang={lang} detailHref={detail(o)} hidden={hidden} stepId={crypto.randomUUID()} canWrite={hasPlan} compact={compact} />
  );
  const totals = done?.totals ?? open.totals;

  return (
    <div className="flex max-w-6xl flex-col gap-5">
      <AssistantTabs lang={lang} dict={dict} shop={shop.slug} current="orders" waiting={waiting} food={tab}>
        <ShopSwitcher shops={chosen.shops} current={shop} label={dict.dashboard.shop} href={(slug) => `/${lang}/dashboard/assistant/orders?shop=${slug}`} />
        {chosen.shops.length > 1 && <p className="text-muted">{shop.name}</p>}
        {!hasPlan && <ProOnly dict={dict} href={`/${lang}/dashboard/plan?shop=${shop.slug}`} />}
      </AssistantTabs>

      <section className="flex flex-col gap-4" data-tab-panel="orders">
        <FoodNotice f={f} ok={first(sp.ok)} err={first(sp.err)} />
        {!enabled ? (
          <div className="flex flex-col gap-2 rounded-xl border border-line p-4" data-food-off>
            <strong>{f.off_title}</strong>
            <p className="text-sm text-muted">{f.off_text}</p>
            <Link href={settingsHref} className="self-start font-semibold underline underline-offset-4">
              {f.settings_link}
            </Link>
          </div>
        ) : (
          <StateStrip
            f={f}
            state={open.state}
            settings={settings}
            timeZone={tz}
            hidden={hidden}
            canWrite={hasPlan}
            sound={
              <FoodOrdersLive
                shopId={shop.id}
                latest={tab?.latest ?? null}
                soundDefault={settings?.alert_sound ?? true}
                labels={{ on: f.sound_on, off: f.sound_off, arrived: f.live_new }}
              />
            }
          />
        )}
        <div className="flex justify-end">
          <Link href={settingsHref} className="flex min-h-11 items-center text-sm font-semibold underline underline-offset-4" data-food-settings-link>
            {f.settings_link}
          </Link>
        </div>

        {/* a phone: the filters and one list */}
        <div className="flex flex-col gap-3 lg:hidden">
          <nav aria-label={f.filters} className="-mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            {FILTERS.map((fv) => (
              <Link
                key={fv}
                href={listHref(fv)}
                aria-current={fv === filter ? "page" : undefined}
                className={`flex min-h-11 flex-none items-center gap-1.5 rounded-full border px-4 text-sm font-semibold ${fv === filter ? "border-foreground bg-foreground text-white" : "border-line"}`}
                data-food-filter={fv}
              >
                {(f as Record<string, string>)[`f_${fv}`]} <span className="tabular-nums">{counts[fv]}</span>
              </Link>
            ))}
          </nav>
          {shown.length ? shown.map((o) => card(o)) : <p className="text-muted">{f.none}</p>}
        </div>

        {/* a computer: the kitchen board */}
        <div className="hidden gap-3 lg:grid lg:grid-cols-4" data-food-board>
          {columns.map((c) => (
            <section key={c.key} className="flex min-w-0 flex-col gap-2.5 rounded-xl bg-[#F6F7F9] p-2.5" aria-label={c.title}>
              <h2 className="flex items-center justify-between px-1 font-bold">
                {c.title} <span className="rounded-full bg-white px-2 text-sm tabular-nums">{c.rows.length}</span>
              </h2>
              {c.rows.length ? c.rows.map((o) => card(o, c.key !== "new")) : <p className="px-1 text-sm text-muted">{f.none}</p>}
            </section>
          ))}
          <section className="flex min-w-0 flex-col gap-2.5 rounded-xl bg-[#F6F7F9] p-2.5" aria-label={f.col_done}>
            <h2 className="px-1 font-bold">{f.col_done}</h2>
            <div className="flex flex-col gap-1 rounded-xl bg-white p-3.5">
              <span className="text-sm text-muted">{f.done_today}</span>
              <strong className="text-3xl tabular-nums">{totals.count}</strong>
              <strong className="text-lg tabular-nums">{money(totals.total_cents, lang)}</strong>
              <span className="text-sm text-muted">{t(f.done_totals, { qr: totals.qr, cash: totals.cash, card: totals.card })}</span>
              <Link href={listHref("done")} className="mt-1 text-sm font-semibold underline underline-offset-4">
                {f.show_all}
              </Link>
            </div>
          </section>
        </div>

        {enabled && <p className="text-sm text-muted">{f.footer_hint}</p>}
      </section>
    </div>
  );
}
