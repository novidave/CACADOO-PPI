import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { formatTime } from "@/lib/format";
import { BOARD_KEYS, type BoardColumn, drawnAt, fill, firstColumn, payMethods, sortActive, sortDone } from "@/lib/foodFeed";
import { foodFeed, foodTab, type FeedCard, type FoodOrders } from "@/lib/foodOwner";
import { money } from "@/lib/foodRules";
import { DbError } from "@/components/DbError";
import { FoodOrdersLive } from "@/components/FoodOrdersLive";
import { BoardSwipe } from "@/components/owner/BoardSwipe";
import { FoodBar } from "@/components/owner/FoodBar";
import { BoardToast, FinishButton, OlderOrders, ReopenButton } from "@/components/owner/FoodFinish";
import { chooseShop } from "../../contacts/parts";
import { hiddenFields, ProOnly } from "../../shared";
import { btn, FoodHead, FoodNotice, mainStep, OrderCard } from "./parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/assistant/orders">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).food.title };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Objednávky jedla → Objednávky (2026-11-07, at the owner's request: no feed — the kitchen board everywhere). First the
 * green bar (@/components/owner/FoodBar: the state, Príprava / Donáška, Meškanie, what the assistant tells customers,
 * "Uzavrieť objednávky"), then the board: from 1024 px four columns — Nové · V príprave · Na ceste / na odber ·
 * Doručené (today's totals, the finished cards with "Vrátiť", "Zobraziť staršie (n)") —, below one column at a time
 * chosen by a segmented row of real radio inputs (Nové first; when Nové is empty, the next column with orders; CSS
 * only, so it works without JavaScript). Each card's plain step is one form with its own step UUID (BoardSwipe: a swipe
 * sends the same form); "Vyzdvihnuté" / "Doručené" opens the payment choice first (FoodFinish → food_order_finish).
 * The page reads itself again when an order comes or changes (FoodOrdersLive, every 10 s, the Cacaduu sound for new
 * ones). Every rule is in SQL (owner_food_feed: members; the steps, finish and reopen: the plan). An old ?view= is
 * dropped (the feed / columns choice is gone).
 */
export default async function OrdersPage({ params, searchParams }: PageProps<"/[lang]/dashboard/assistant/orders">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  if (sp.view !== undefined) {
    const query = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (k === "view" || v === undefined ? [] : [[k, String(first(v))]])));
    const q = query.toString();
    redirect(`/${lang}/dashboard/assistant/orders${q ? `?${q}` : ""}`);
  }
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const f = dict.food;
  const chosen = await chooseShop(supabase, first(sp.shop));
  if (chosen.error) return <DbError message={chosen.error} dict={dict} />;
  const shop = chosen.shop;
  if (!shop) redirect(`/${lang}/dashboard`);

  const [plan, feed, doneRes, tab] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    foodFeed(supabase, shop.id),
    supabase.rpc("owner_food_orders", { p_shop_id: shop.id, p_filter: "done", p_limit: 1 }),
    foodTab(supabase, shop.id),
  ]);
  if (!feed) return <DbError message={f.err_failed} dict={dict} />;
  const hasPlan = !plan.error && plan.data === true;
  const totals = (doneRes.data as FoodOrders | null)?.totals ?? null;
  const hidden = hiddenFields(lang, shop);
  const settings = feed.settings;
  const parts = feed.parts;
  const enabled = Boolean(settings.enabled);
  const tz = feed.timezone;
  const settingsHref = `/${lang}/dashboard/assistant/orders/settings?shop=${shop.slug}`;
  const detailBase = { path: `/${lang}/dashboard/assistant/orders/`, query: `?shop=${encodeURIComponent(shop.slug)}` };
  const detail = (o: FeedCard) => `${detailBase.path}${o.id}${detailBase.query}`;
  const couriersHref = `/${lang}/dashboard/assistant/orders/couriers?shop=${encodeURIComponent(shop.slug)}`;
  const texts = f as Record<string, string>;
  const labels = Object.fromEntries(BOARD_KEYS.map((k) => [k, texts[k] ?? ""]));
  const methods = payMethods(settings, parts);
  const hm = (iso: string | null) => (iso ? formatTime(new Date(iso), tz) : "");

  // the columns: active cards by status; with the courier app an order on the way counts as done in SQL, the board
  // still shows it under "Na ceste"; Doručené = picked up, delivered or cancelled today
  const order = settings.feed_order ?? "newest";
  const byStatus = (list: FeedCard[], s: FeedCard["status"][]) => list.filter((o) => s.includes(o.status));
  const rows: Record<BoardColumn, FeedCard[]> = {
    new: sortActive(byStatus(feed.active, ["new"]), order),
    preparing: sortActive(byStatus(feed.active, ["preparing"]), order),
    on_the_way: sortActive([...byStatus(feed.active, ["ready", "on_the_way"]), ...byStatus(feed.done, ["on_the_way"])], order),
    done: sortDone(byStatus(feed.done, ["picked_up", "delivered", "cancelled"])),
  };
  const counts = { new: rows.new.length, preparing: rows.preparing.length, on_the_way: rows.on_the_way.length, done: rows.done.length };
  const wanted = first(sp.col);
  const open: BoardColumn = wanted === "new" || wanted === "preparing" || wanted === "on_the_way" || wanted === "done" ? wanted : firstColumn(counts);
  const titles: Record<BoardColumn, string> = { new: f.f_new, preparing: f.f_preparing, on_the_way: f.col_on_the_way, done: f.col_done };
  const segment: Record<BoardColumn, string> = { new: f.f_new, preparing: f.f_preparing, on_the_way: f.seg_on_the_way, done: f.col_done };

  const card = (o: FeedCard, compact: boolean) => {
    const step = hasPlan ? mainStep(f, o) : null;
    const finishing = step && (step.to === "delivered" || step.to === "picked_up");
    const drawn = (
      <OrderCard
        key={o.id}
        f={f}
        o={o}
        lang={lang}
        detailHref={detail(o)}
        hidden={hidden}
        stepId={crypto.randomUUID()}
        canWrite={hasPlan}
        compact={compact}
        payments={parts.payments}
        finish={
          finishing && step ? (
            <FinishButton
              shopId={shop.id}
              lang={lang}
              order={o}
              parts={parts}
              methods={methods}
              couriers={feed.couriers}
              couriersHref={couriersHref}
              qrHref={parts.qr_terminal ? detail(o) : null}
              labels={labels}
              className={`${btn} flex-1`}
            >
              {step.label}
            </FinishButton>
          ) : undefined
        }
      />
    );
    // a plain next step can be swiped (the same step form); a finishing step opens the payment choice first
    return step && !finishing ? (
      <BoardSwipe key={o.id} label={step.label}>
        {drawn}
      </BoardSwipe>
    ) : (
      drawn
    );
  };

  const doneCard = (o: FeedCard) => {
    const summary = o.kind === "delivery" ? fill(f.feed_delivery_short, { address: [o.address, o.zone_name].filter(Boolean).join(" · ") }) : f.feed_pickup_short;
    return (
      <article key={o.id} className="flex flex-col gap-1 rounded-xl border border-[#E4E4E4] bg-[#F2F2F2] p-3 text-[#5C5C5C]" data-food-order={o.number} data-status={o.status}>
        <div className="flex items-baseline justify-between gap-2">
          <Link href={detail(o)} className="min-w-0 truncate font-semibold text-foreground">
            #{o.number}
            {o.name ? ` · ${o.name}` : ""}
          </Link>
          <span className="flex-none text-sm font-semibold tabular-nums">{money(o.total_cents, lang, o.currency)}</span>
        </div>
        <span className="text-sm">
          {hm(o.created_at)} · {summary}
        </span>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold">{o.status === "cancelled" ? f.feed_cancelled : fill(f.feed_done_at, { time: hm(o.done_at) })}</span>
          {hasPlan && <ReopenButton shopId={shop.id} order={o} labels={labels} />}
        </div>
      </article>
    );
  };

  const columns: BoardColumn[] = ["new", "preparing", "on_the_way", "done"];

  return (
    <div className="flex w-full flex-col gap-5" data-food-page>
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
      <div className="flex max-w-6xl flex-col gap-4">
        {/* THE GREEN BAR: the first block under the tabs */}
        {enabled && (
          <FoodBar
            shopId={shop.id}
            initial={{ times: feed.times, parts, state: feed.state, settings, timezone: tz }}
            labels={labels}
            canWrite={hasPlan}
            serverNow={drawnAt()}
          />
        )}
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
          <div className="flex flex-wrap items-center justify-end gap-2">
            {enabled && (
              <FoodOrdersLive
                shopId={shop.id}
                latest={tab?.latest ?? null}
                changed={tab?.changed ?? null}
                soundDefault={settings.alert_sound ?? true}
                labels={{ on: f.sound_on, off: f.sound_off, arrived: f.live_new }}
              />
            )}
            <Link href={settingsHref} className="flex min-h-11 items-center text-sm font-semibold underline underline-offset-4" data-food-settings-link>
              {f.settings_link}
            </Link>
          </div>

          {/* the kitchen board: four columns from 1024 px; below, one column at a time (the radios, CSS only) */}
          <div className="flex flex-col gap-3" data-food-board-wrap>
            <fieldset className="lg:hidden" data-food-segments>
              <legend className="sr-only">{f.board_columns}</legend>
              <div className="grid grid-cols-4 gap-1 rounded-xl bg-[#EEF1F5] p-1">
                {columns.map((c) => (
                  <label
                    key={c}
                    className="flex min-h-11 cursor-pointer items-center justify-center gap-1 rounded-lg px-1 text-center text-[13px] font-semibold leading-tight has-[:checked]:bg-foreground has-[:checked]:text-white has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[#2563EB]"
                    data-food-segment={c}
                  >
                    <input type="radio" name="food-board-column" value={c} defaultChecked={c === open} className="sr-only" />
                    <span>
                      {segment[c]} <span className="tabular-nums">{counts[c]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-4" data-food-board>
              {columns.map((c) => (
                <section key={c} className="flex min-w-0 flex-col gap-2.5 rounded-xl bg-[#F6F7F9] p-2.5" aria-label={titles[c]} data-board-col={c}>
                  <h2 className="flex items-center justify-between px-1 font-bold">
                    {titles[c]} <span className="rounded-full bg-white px-2 text-sm tabular-nums">{counts[c]}</span>
                  </h2>
                  {c === "done" && totals && (
                    <div className="flex flex-col gap-1 rounded-xl bg-white p-3.5" data-food-totals>
                      <span className="text-sm text-muted">{f.done_today}</span>
                      <strong className="text-2xl tabular-nums">{totals.count}</strong>
                      <strong className="text-lg tabular-nums">{money(totals.total_cents, lang)}</strong>
                      {parts.payments && <span className="text-sm text-muted">{t(f.done_totals, { qr: totals.qr, cash: totals.cash, card: totals.card })}</span>}
                    </div>
                  )}
                  {rows[c].length ? rows[c].map((o) => (c === "done" ? doneCard(o) : card(o, c !== "new"))) : <p className="px-1 text-sm text-muted">{f.none}</p>}
                  {c === "done" && (
                    <OlderOrders shopId={shop.id} count={feed.older_count} lang={lang} timezone={tz} labels={labels} detailBase={detailBase} />
                  )}
                </section>
              ))}
            </div>
          </div>

          {enabled && <p className="text-sm text-muted">{f.footer_hint}</p>}
        </section>
      </div>
      <BoardToast labels={labels} />
    </div>
  );
}
