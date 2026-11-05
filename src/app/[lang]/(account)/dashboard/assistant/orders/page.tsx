import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { drawnAt, FEED_KEYS, FOOD_VIEW_BOOT, type FeedLabels } from "@/lib/foodFeed";
import { foodFeed, foodTab, type FoodOrder, type FoodOrders } from "@/lib/foodOwner";
import { money } from "@/lib/foodRules";
import { DbError } from "@/components/DbError";
import { FoodOrdersLive } from "@/components/FoodOrdersLive";
import { FoodFeed } from "@/components/owner/FoodFeed";
import { FoodViewSwitch } from "@/components/owner/FoodViewSwitch";
import { chooseShop } from "../../contacts/parts";
import { hiddenFields, ProOnly } from "../../shared";
import { FoodHead, FoodNotice, OrderCard, StateStrip } from "./parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/assistant/orders">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).food.title };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
type Column = "new" | "preparing" | "on_the_way";

/**
 * Objednávky jedla → Objednávky. Since database update 81 the **feed** by default (artboards 5a tablet, 5c phone:
 * @/components/owner/FoodFeed — the cards, swipe to finish, "Vybavené dnes", the times and the delay the assistant
 * uses); "Feed | Stĺpce" (from 1024 px, remembered per device, @/components/owner/FoodViewSwitch) opens the kitchen
 * board of boards 11–13 — the state strip and four columns (Nové, V príprave, Na ceste / na odber, Doručené with
 * today's totals), each card's main step one form with its own step UUID. A phone shows only the feed. The page reads
 * itself again when an order comes or changes (FoodOrdersLive, every 10 s, the Cacaduu sound for new ones). Every
 * rule is in SQL (owner_food_feed / owner_food_orders: members; the steps, finish and reopen: the plan).
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
  const viewParam = first(sp.view);
  const view = viewParam === "columns" || viewParam === "feed" ? viewParam : null;

  const [plan, openRes, doneRes, tab, feed] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    supabase.rpc("owner_food_orders", { p_shop_id: shop.id, p_filter: "open", p_limit: 200 }),
    supabase.rpc("owner_food_orders", { p_shop_id: shop.id, p_filter: "done", p_limit: 100 }),
    foodTab(supabase, shop.id),
    foodFeed(supabase, shop.id),
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
  const viewHref = (v: "feed" | "columns") => `/${lang}/dashboard/assistant/orders?${new URLSearchParams({ shop: shop.slug, view: v })}`;
  const labels = Object.fromEntries(FEED_KEYS.map((k) => [k, (f as Record<string, string>)[k] ?? ""])) as FeedLabels;
  const byStatus = (s: FoodOrder["status"][]) => open.orders.filter((o) => s.includes(o.status)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const columns: { key: Column; title: string; rows: FoodOrder[] }[] = [
    { key: "new", title: f.f_new, rows: byStatus(["new"]) },
    { key: "preparing", title: f.f_preparing, rows: byStatus(["preparing"]) },
    { key: "on_the_way", title: f.col_on_the_way, rows: byStatus(["on_the_way", "ready"]) },
  ];
  const card = (o: FoodOrder, compact = false) => (
    <OrderCard key={o.id} f={f} o={o} lang={lang} detailHref={detail(o)} hidden={hidden} stepId={crypto.randomUUID()} canWrite={hasPlan} compact={compact} payments={tab?.parts?.payments ?? true} />
  );
  const totals = done?.totals ?? open.totals;

  return (
    <div className="flex w-full flex-col gap-5" data-food-page data-view={view ?? undefined}>
      <FoodHead
        dict={dict}
        lang={lang}
        shops={chosen.shops}
        shop={shop}
        current="orders"
        newOrders={tab?.new ?? 0}
        couriers={tab?.parts?.courier_app ?? true}
        switchHref={(slug) => `/${lang}/dashboard/assistant/orders?shop=${slug}`}
      />
      {/* the device's "Feed | Stĺpce" before the first paint (globals.css shows one view) */}
      <script dangerouslySetInnerHTML={{ __html: FOOD_VIEW_BOOT }} />
      <div className="flex max-w-6xl flex-col gap-5">
      {!hasPlan && <ProOnly dict={dict} href={`/${lang}/dashboard/plan?shop=${shop.slug}`} />}

      <section className="flex flex-col gap-4" data-tab-panel="orders">
        <FoodNotice f={f} ok={first(sp.ok)} err={first(sp.err)} />
        {!enabled && (
          <div className="flex flex-col gap-2 rounded-xl border border-line p-4" data-food-off>
            <strong>{f.off_title}</strong>
            <p className="text-sm text-muted">{f.off_text}</p>
            <Link href={settingsHref} className="self-start font-semibold underline underline-offset-4">
              {f.settings_link}
            </Link>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <FoodViewSwitch
            initial={view ?? "feed"}
            labels={{ label: f.feed_view_label, feed: f.feed_view_feed, columns: f.feed_view_columns }}
            hrefs={{ feed: viewHref("feed"), columns: viewHref("columns") }}
          />
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {enabled && (
              <FoodOrdersLive
                shopId={shop.id}
                latest={tab?.latest ?? null}
                changed={tab?.changed ?? null}
                soundDefault={settings?.alert_sound ?? true}
                labels={{ on: f.sound_on, off: f.sound_off, arrived: f.live_new }}
              />
            )}
            <Link href={settingsHref} className="flex min-h-11 items-center text-sm font-semibold underline underline-offset-4" data-food-settings-link>
              {f.settings_link}
            </Link>
          </div>
        </div>

        {/* the feed (every size; the only view on a phone) */}
        <div data-food-feed-view>
          {feed ? (
            <FoodFeed
              shopId={shop.id}
              lang={lang}
              initial={feed}
              labels={labels}
              canWrite={hasPlan}
              detailBase={{ path: `/${lang}/dashboard/assistant/orders/`, query: `?shop=${encodeURIComponent(shop.slug)}` }}
              couriersHref={`/${lang}/dashboard/assistant/orders/couriers?shop=${encodeURIComponent(shop.slug)}`}
              serverNow={drawnAt()}
            />
          ) : (
            <p role="alert" className="rounded-lg border border-[#D64545] p-3">{f.err_failed}</p>
          )}
        </div>

        {/* "Stĺpce": the kitchen board (from 1024 px, when the device chose it) */}
        <div className="flex-col gap-4" data-food-board-view>
          {enabled && <StateStrip f={f} state={open.state} settings={settings} timeZone={tz} hidden={hidden} canWrite={hasPlan} />}
          <div className="mt-4 grid grid-cols-4 gap-3" data-food-board>
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
                <Link href={`${viewHref("feed")}#feed-done`} className="mt-1 text-sm font-semibold underline underline-offset-4">
                  {f.show_all}
                </Link>
              </div>
            </section>
          </div>
        </div>

        {enabled && <p className="text-sm text-muted">{f.footer_hint}</p>}
      </section>
      </div>
    </div>
  );
}
