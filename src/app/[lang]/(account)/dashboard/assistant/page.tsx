import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import Link from "next/link";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { BOOKING_TAB_OF_PART, bookingPartUrl, forwardUrl, movedFrom } from "@/lib/dashboardPages";
import { foodTab } from "@/lib/foodOwner";
import type { MyShop } from "@/lib/myShops";
import { DbError } from "@/components/DbError";
import { itemTabs, PageHead } from "@/components/owner/PageHead";
import { SaveBar } from "@/components/owner/SaveBar";
import { cardClass, fieldClass, ghostClass } from "@/components/owner/ui";
import { WelcomeField } from "@/components/owner/WelcomeField";
import { ASSISTANT_PARTS, AssistantSettings } from "../AssistantSettings";
import { hiddenFields, messages, ProOnly, ShopSwitcher } from "../shared";
import { saveAssistantPage } from "./settingsActions";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/assistant">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).nav.assistant };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * AI asistent → Nastavenia (back-end layout L2, 2026-11-03): the assistant's texts, the way to "Objednávky jedla v
 * asistentovi" and to the private folders. Its tabs: Nastavenia · Dokumenty (/dashboard/assistant/documents) ·
 * Súkromné priečinky (/dashboard/assistant/folders). What used to be here moved, and its old addresses are forwarded
 * with their query: Prehľad and Konverzácie (`?at=overview|conversations|cloud`) to CRM (/dashboard/crm); the
 * bookings' setup (`?at=settings&part=rules|services|resources|blocks|calendar|messages`) to its Rezervácie tab.
 */
export default async function AssistantPage({ params, searchParams }: PageProps<"/[lang]/dashboard/assistant">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const at = first(sp.at) ?? "";
  if (movedFrom("assistant", at)) redirect(forwardUrl(lang, at, sp));
  const part = first(sp.part) ?? "";
  if (BOOKING_TAB_OF_PART[part]) {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(sp)) if (k !== "at" && k !== "part" && typeof first(v) === "string") query[k] = first(v)!;
    redirect(bookingPartUrl(lang, part, query));
  }
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const d = dict.dashboard;

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];

  const kind = shop.kind === "food" ? "food" : "goods";
  const [hasPlan, food, flagsRes, tgRes, bookingRes, docsRes, foldersRes] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    // the switch of "Objednávky jedla v asistentovi" (database update 74)
    foodTab(supabase, shop.id),
    // "Keď asistent nevie odpovedať" (database update 91)
    supabase.rpc("owner_assistant_flags", { p_shop_id: shop.id }),
    // the shop's Telegram notices (update 66; none while Telegram is not linked)
    supabase.rpc("owner_telegram_prefs"),
    // Rezervácie's "Prijímať rezervácie" (update 63)
    supabase.rpc("owner_booking_setup", { p_shop_id: shop.id }),
    supabase.from("shop_documents").select("id, name, folder_id, status, created_at", { count: "exact" }).eq("shop_id", shop.id).order("created_at", { ascending: false }).limit(5),
    supabase.from("shop_folders").select("id, is_public").eq("shop_id", shop.id),
  ]);
  const planActive = !hasPlan.error && hasPlan.data === true;
  const m = messages(dict, sp);
  const hidden = hiddenFields(lang, shop);
  const planUrl = `/${lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`;
  const a = dict.asst;
  const x = dict.asst_page;
  const flags = (flagsRes.error ? null : flagsRes.data) as { ask_contact: boolean; alert_email_on: boolean } | null;
  const tg = tgRes.error ? null : ((tgRes.data ?? []) as { shop_id: string; notify: Record<string, boolean> }[]).find((p) => p.shop_id === shop.id) ?? null;
  const bookingsOn = bookingRes.error ? null : Boolean((bookingRes.data as { rules?: { enabled?: boolean } } | null)?.rules?.enabled);
  const publicFolders = new Set(((foldersRes.data ?? []) as { id: string; is_public: boolean }[]).filter((f) => f.is_public).map((f) => f.id));
  const docs = (docsRes.error ? [] : (docsRes.data ?? [])) as { id: string; name: string; folder_id: string }[];
  const docsTotal = docsRes.error ? 0 : (docsRes.count ?? docs.length);
  const docsHref = `/${lang}/dashboard/assistant/documents?${new URLSearchParams({ shop: shop.slug })}`;
  const ok = first(sp.ok);
  const err = first(sp.err);
  const asstTexts = a as Record<string, string>;
  // the forms come back with ?ok= / ?err= (the save bar's own, or the older `part=` texts form's)
  const notice =
    m.notice("settings") ??
    (ok ? (
      <p role="status" className="rounded-xl border border-foreground p-3 font-medium" data-assistant-notice>
        {ok === "saved" ? dict.account.saved : ok === "assistant_cleaned" ? d.assistant_cleaned : (asstTexts[ok] ?? dict.account.saved)}
      </p>
    ) : err ? (
      <p role="alert" className="rounded-xl border border-line p-3" data-assistant-notice>
        {err === "no_plan" ? dict.dashboard.pro_only : err === "err_telegram" ? x.err_telegram : (asstTexts[err] ?? asstTexts.err_failed)}
      </p>
    ) : null);
  const box = (flag: boolean | null | undefined) => (flag ? "1" : "0");
  const row = "flex min-h-14 items-center justify-between gap-3 border-t border-[#E4E4E4] text-base font-semibold first-of-type:border-t-0";

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHead
        title={dict.nav.assistant}
        item="assistant"
        tabs={itemTabs(dict, lang, "assistant", shop.slug)}
        current="settings"
        tabsLabel={dict.nav.tabs_label}
        actions={
          shop.is_active ? (
            <a href={`/${lang}/shops/${shop.slug}#assistant`} target="_blank" rel="noopener" className={ghostClass} data-try-assistant>
              {x.try}
            </a>
          ) : null
        }
      >
        <ShopSwitcher shops={shops} current={shop} label={d.shop} href={(slug) => `/${lang}/dashboard/assistant?${new URLSearchParams({ shop: slug })}`} />
        {shops.length > 1 && <p className="text-muted">{shop.name}</p>}
      </PageHead>
      <div id="settings" className="flex w-full max-w-[1180px] scroll-mt-4 flex-col gap-[18px]">
        {notice}
        {/* artboard 12: ONE form for a, b and c (one save bar); d is links only */}
        <form action={saveAssistantPage} className="flex flex-col gap-[18px]" data-assistant-form>
          {hidden({})}
          <div className="grid gap-[18px] lg:grid-cols-2 lg:items-start">
            <div className="flex min-w-0 flex-col gap-[18px]">
              {/* a) Na stránke obchodu */}
              <section className={cardClass} aria-labelledby="asst-page" data-assistant-texts>
                <h2 id="asst-page" className="text-[19px] font-bold">
                  {x.on_page}
                </h2>
                {planActive ? (
                  <>
                    <input type="hidden" name="has_texts" value="1" />
                    <input type="hidden" name="was_label" value={shop.assistant_label ?? ""} />
                    <input type="hidden" name="was_welcome" value={shop.assistant_welcome ?? ""} />
                    <label className="flex flex-col gap-1.5">
                      <span className="text-sm font-semibold">{x.button_text}</span>
                      <input name="assistant_label" maxLength={40} defaultValue={shop.assistant_label ?? ""} placeholder={dict.chat.title} className={fieldClass} />
                    </label>
                    <WelcomeField
                      label={x.welcome}
                      defaultValue={shop.assistant_welcome ?? ""}
                      placeholder={dict.chat.intro}
                      className={fieldClass}
                      insertLabel={d.welcome_list_insert}
                      hint={d.welcome_list_hint}
                    />
                    <p className="text-[13px] text-muted">{d.assistant_hint}</p>
                  </>
                ) : (
                  <ProOnly dict={dict} href={planUrl} />
                )}
              </section>

              {/* b) Keď asistent nevie odpovedať */}
              <section className={`${cardClass} gap-0`} aria-labelledby="asst-unanswered" data-assistant-unanswered>
                <h2 id="asst-unanswered" className="pb-2 text-[19px] font-bold">
                  {x.unanswered}
                </h2>
                {flags ? (
                  <>
                    <input type="hidden" name="has_ask_contact" value="1" />
                    <input type="hidden" name="was_ask_contact" value={box(flags.ask_contact)} />
                    <input type="hidden" name="has_alert_email_on" value="1" />
                    <input type="hidden" name="was_alert_email_on" value={box(flags.alert_email_on)} />
                    <label className={row}>
                      {x.ask_contact}
                      <input type="checkbox" name="ask_contact" defaultChecked={flags.ask_contact} className="ppi-toggle" data-switch="ask_contact" />
                    </label>
                    <label className={row}>
                      {x.alert_email}
                      <input type="checkbox" name="alert_email_on" defaultChecked={flags.alert_email_on} className="ppi-toggle" data-switch="alert_email_on" />
                    </label>
                  </>
                ) : (
                  <p className="text-sm text-muted">{x.unavailable}</p>
                )}
                {tg ? (
                  <>
                    <input type="hidden" name="has_tg_callback" value="1" />
                    <input type="hidden" name="was_tg_callback" value={box(tg.notify?.callback === true)} />
                    <label className={row}>
                      {x.alert_telegram}
                      <input type="checkbox" name="tg_callback" defaultChecked={tg.notify?.callback === true} className="ppi-toggle" data-switch="tg_callback" />
                    </label>
                  </>
                ) : (
                  <div className={`${row} text-[#9A9A9A]`} data-switch-off="tg_callback">
                    <span className="flex flex-col">
                      {x.alert_telegram}
                      <Link href={`/${lang}/dashboard/sms-telegram?${new URLSearchParams({ shop: shop.slug, tab: "telegram" })}`} className="text-[13px] font-medium text-[#5C5C5C] underline underline-offset-4">
                        {x.telegram_link}
                      </Link>
                    </span>
                    <input type="checkbox" disabled className="ppi-toggle" aria-label={x.alert_telegram} />
                  </div>
                )}
              </section>
            </div>

            <div className="flex min-w-0 flex-col gap-[18px]">
              {/* c) Čo asistent robí */}
              <section className={`${cardClass} gap-0`} aria-labelledby="asst-does" data-assistant-does>
                <h2 id="asst-does" className="pb-2 text-[19px] font-bold">
                  {x.does}
                </h2>
                <label className={`${row} opacity-60`}>
                  {x.does_stock}
                  <input type="checkbox" checked disabled readOnly className="ppi-toggle" />
                </label>
                {bookingsOn !== null && (
                  <>
                    {planActive && <input type="hidden" name="has_bookings" value="1" />}
                    <input type="hidden" name="was_bookings" value={box(bookingsOn)} />
                    <div className={row}>
                      <span>
                        {x.does_bookings_before}{" "}
                        <Link href={`/${lang}/dashboard/bookings?${new URLSearchParams({ shop: shop.slug })}`} className="underline underline-offset-4">
                          {x.does_bookings_link}
                        </Link>
                      </span>
                      <input type="checkbox" name="bookings" defaultChecked={bookingsOn} disabled={!planActive} aria-label={`${x.does_bookings_before} ${x.does_bookings_link}`} className="ppi-toggle" data-switch="bookings" />
                    </div>
                  </>
                )}
                {kind === "food" && food && (
                  <>
                    <input type="hidden" name="has_food" value="1" />
                    <input type="hidden" name="was_food" value={box(food.enabled)} />
                    <div className={row}>
                      <span>
                        {x.does_food_before}{" "}
                        <Link href={`/${lang}/dashboard/assistant/orders?${new URLSearchParams({ shop: shop.slug })}`} className="underline underline-offset-4">
                          {x.does_food_link}
                        </Link>
                      </span>
                      <input type="checkbox" name="food" defaultChecked={food.enabled} aria-label={`${x.does_food_before} ${x.does_food_link}`} className="ppi-toggle" data-switch="food" />
                    </div>
                  </>
                )}
                <p className="pt-2.5 text-sm text-muted">
                  {x.crm_before}{" "}
                  <Link href={`/${lang}/dashboard/crm?${new URLSearchParams({ shop: shop.slug })}`} className="underline underline-offset-4">
                    {x.crm_link}
                  </Link>
                  .
                </p>
              </section>

              {/* d) Znalostná báza asistenta (the uploader and its terms live on the Dokumenty tab) */}
              <section className={`${cardClass} gap-0`} aria-labelledby="asst-docs" data-assistant-docs>
                <div className="flex items-center justify-between gap-3 pb-1.5">
                  <h2 id="asst-docs" className="text-[19px] font-bold">
                    {x.docs}
                  </h2>
                  <Link href={`${docsHref}#upload`} className={`${ghostClass} min-h-12 text-[15px]`} data-docs-upload>
                    {x.docs_upload}
                  </Link>
                </div>
                {docs.length === 0 ? (
                  <p className="border-t border-[#E4E4E4] py-3 text-sm text-muted">{x.docs_none}</p>
                ) : (
                  <ul className="flex flex-col">
                    {docs.map((doc) => (
                      <li key={doc.id} className="flex min-h-[60px] items-center justify-between gap-2.5 border-t border-[#E4E4E4] text-base" data-assistant-doc>
                        <span className="min-w-0 truncate">{doc.name}</span>
                        <span className="inline-flex h-6 flex-none items-center rounded-md border border-[#D6D6D6] px-2 text-xs font-bold">
                          {publicFolders.has(doc.folder_id) ? x.doc_public : x.doc_private}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {docsTotal > 0 && (
                  <Link href={docsHref} className="flex min-h-11 items-center border-t border-[#E4E4E4] pt-1 text-[15px] font-bold underline underline-offset-4" data-docs-all>
                    {t(x.docs_all, { n: docsTotal })}
                  </Link>
                )}
              </section>
            </div>
          </div>
          <SaveBar labels={{ unsaved: dict.owner.unsaved, cancel: dict.owner.cancel_changes, save: dict.account.save, saving: dict.owner.saving }} />
        </form>

        {/* the other parts of this tab, as before: Objednávky jedla's card (a restaurant), the private folders */}
        <AssistantSettings
          setup={null}
          shop={shop}
          lang={lang}
          dict={dict}
          planActive={planActive}
          planUrl={planUrl}
          hidden={hidden}
          notice={() => null}
          googleOn
          food={food}
          only={ASSISTANT_PARTS.filter((part) => part !== "texts")}
        />
      </div>
    </div>
  );
}
