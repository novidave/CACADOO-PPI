import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { formatDateTime, utcToLocalInput } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { CalendarFeedForm } from "@/components/CalendarFeedForm";
import { PendingButton } from "@/components/PendingButton";
import { saveAssistantTexts } from "./actions";
import { connectGoogle, disconnectGoogle } from "./bookings/actions";
import {
  calendarFeedOff,
  removeBlock,
  removeResource,
  removeService,
  saveBlock,
  saveBookingRules,
  saveCrmSettings,
  saveResource,
  saveService,
} from "./assistant/actions";
import { Field, inputClass, ProOnly } from "./shared";

/** owner_booking_setup() (database update 63). */
export interface BookingSetup {
  plan: boolean;
  /** step 5 / 10 / 15 / 30 min; 1–20 bookings per customer a day (owner_save_booking_rules) */
  rules: { enabled: boolean; min_notice: number; max_days: number; step: number; max_per_contact_day: number | null };
  crm: { reminder_on: boolean; reminder_offset: "2h" | "day_before_18"; alert_email: string | null; notify_on_owner_change: boolean };
  services: {
    id: string; name: string; duration: number; buffer_before: number; buffer_after: number; capacity: number;
    needs_resource: boolean; active: boolean; offered_by_assistant: boolean; note: string | null; resource_ids: string[];
  }[];
  resources: { id: string; name: string; kind: "person" | "machine" | "room"; active: boolean; hours: unknown }[];
  blocks: { id: string; resource_id: string | null; starts_at: string; ends_at: string; note: string | null }[];
  feed: { created_at: string } | null;
  google: { status: string; last_error: string | null; connected_at: string } | null;
  timezone: string;
}

const card = "flex scroll-mt-4 flex-col gap-3 rounded-xl border border-line p-4";
const ghost = "min-h-11 rounded-[10px] border border-line bg-white px-4 text-[15px] font-semibold";
const check = "h-5 w-5 shrink-0 accent-foreground";

/**
 * Asistent → Nastavenia (update 63, the Šablóny/Nastavenia screen): the assistant's texts, "Automatické správy" (the
 * SMS code is always on; the reminder 2 h before or the evening before; the e-mail when the assistant cannot answer;
 * SMS to the customer when the owner moves or cancels), "Rezervácie" (rules, services, resources, blocked times, the
 * optional Google Calendar and the read-only calendar link) and the way to "Súkromné priečinky". Cacaduu's bookings work
 * without any outside calendar; every rule is checked again in SQL.
 */
export function AssistantSettings({
  setup,
  shop,
  lang,
  dict,
  planActive,
  planUrl,
  hidden,
  notice,
  googleOn,
}: {
  setup: BookingSetup | null;
  shop: MyShop;
  lang: Locale;
  dict: Dictionary;
  planActive: boolean;
  planUrl: string;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  notice: (part: string) => React.ReactNode;
  googleOn: boolean;
}) {
  const a = dict.asst;
  const d = dict.dashboard;
  const b = dict.bookings as Record<string, string>;
  const tz = setup?.timezone ?? shop.timezone;
  const resourceName = (id: string | null) => setup?.resources.find((r) => r.id === id)?.name ?? a.block_whole_shop;
  const kindLabel = (k: string) => (k === "machine" ? a.kind_machine : k === "room" ? a.kind_room : a.kind_person);
  const ro = !planActive;

  return (
    <div className="flex flex-col gap-4" data-tab-panel="settings">
      {/* Texty asistenta */}
      <section id="texts" className={card} data-settings-part="texts">
        <h2 className="text-[17px] font-bold">{a.texts_title}</h2>
        {notice("texts")}
        {planActive ? (
          <form action={saveAssistantTexts} className="flex flex-col gap-3">
            {hidden({ at: "assistant" })}
            <Field label={d.assistant_label}>
              <input name="assistant_label" maxLength={40} defaultValue={shop.assistant_label ?? ""} placeholder={dict.chat.title} className={inputClass} />
            </Field>
            <Field label={d.assistant_welcome}>
              <textarea name="assistant_welcome" maxLength={300} rows={3} defaultValue={shop.assistant_welcome ?? ""} placeholder={dict.chat.intro} className={inputClass} />
            </Field>
            <p className="text-sm text-muted">{d.assistant_hint}</p>
            <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>
          </form>
        ) : (
          <ProOnly dict={dict} href={planUrl} />
        )}
      </section>

      {!setup ? (
        <p className="text-sm text-muted">{a.setup_unavailable}</p>
      ) : (
        <>
          {/* Automatické správy */}
          <section id="messages" className={card} data-settings-part="messages">
            <h2 className="text-[17px] font-bold">{a.auto_title}</h2>
            {notice("messages")}
            <div className="flex items-center justify-between gap-3 text-[15px]">
              <span>
                {a.auto_code}
                <br />
                <span className="text-[13px] text-muted">{a.auto_code_hint}</span>
              </span>
              <input type="checkbox" checked disabled aria-label={a.auto_code} className={check} />
            </div>
            <form action={saveCrmSettings} className="flex flex-col gap-3">
              {hidden({ part: "messages" })}
              <label className="flex min-h-11 items-center justify-between gap-3 text-[15px]">
                {a.auto_reminder}
                <input type="checkbox" name="reminder_on" defaultChecked={setup.crm.reminder_on} disabled={ro} className={check} />
              </label>
              <label className="flex flex-col gap-1 text-[13px] text-muted">
                {a.auto_when}
                <select name="reminder_offset" defaultValue={setup.crm.reminder_offset} disabled={ro} className={`${inputClass} min-h-11 bg-white text-[15px] text-foreground`}>
                  <option value="2h">{a.auto_2h}</option>
                  <option value="day_before_18">{a.auto_day_before}</option>
                </select>
              </label>
              <label className="flex min-h-11 items-center justify-between gap-3 text-[15px]">
                {a.auto_owner_change}
                <input type="checkbox" name="notify_on_owner_change" defaultChecked={setup.crm.notify_on_owner_change} disabled={ro} className={check} />
              </label>
              <label className="flex flex-col gap-1 text-[15px]">
                {a.auto_alert_email}
                <input type="email" name="alert_email" maxLength={254} defaultValue={setup.crm.alert_email ?? ""} placeholder={a.auto_alert_placeholder} disabled={ro} className={inputClass} />
                <span className="text-[13px] text-muted">{a.auto_alert_hint}</span>
              </label>
              {planActive && <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>}
            </form>
          </section>

          {/* Rezervácie: pravidlá */}
          <section id="rules" className={card} data-settings-part="rules">
            <h2 className="text-[17px] font-bold">{a.rules_title}</h2>
            <p className="text-sm text-muted">{a.rules_intro}</p>
            {notice("rules")}
            <form action={saveBookingRules} className="flex flex-col gap-3">
              {hidden({ part: "rules" })}
              <label className="flex min-h-11 items-center justify-between gap-3 text-[15px] font-semibold">
                {a.rules_enabled}
                <input type="checkbox" name="enabled" defaultChecked={setup.rules.enabled} disabled={ro} className={check} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <Field label={a.rules_min_notice}>
                  <input type="number" name="min_notice_hours" min={0} max={720} step={0.5} defaultValue={setup.rules.min_notice / 60} disabled={ro} className={inputClass} />
                </Field>
                <Field label={a.rules_max_days}>
                  <input type="number" name="max_days" min={1} max={365} defaultValue={setup.rules.max_days} disabled={ro} className={inputClass} />
                </Field>
                <Field label={a.rules_step}>
                  <select name="step" defaultValue={String(setup.rules.step)} disabled={ro} className={`${inputClass} bg-white`}>
                    {[5, 10, 15, 30].map((n) => (
                      <option key={n} value={n}>
                        {t(a.minutes, { n })}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={a.rules_per_contact}>
                  <input type="number" name="max_per_contact_day" required min={1} max={20} defaultValue={setup.rules.max_per_contact_day ?? 2} disabled={ro} className={inputClass} />
                </Field>
              </div>
              <p className="text-[13px] text-muted">{a.rules_hint}</p>
              {planActive && <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>}
            </form>
          </section>

          {/* Služby */}
          <section id="services" className={card} data-settings-part="services">
            <h2 className="text-[17px] font-bold">{a.services_title}</h2>
            <p className="text-sm text-muted">{a.services_intro}</p>
            {notice("services")}
            {setup.services.length === 0 && <p className="text-sm font-semibold">{a.services_none}</p>}
            {[...setup.services, null].map((s) =>
              s === null && !planActive ? null : (
                <details key={s?.id ?? "new"} className="rounded-[10px] border border-line p-3" open={s === null && setup.services.length === 0} data-service={s?.id ?? "new"}>
                  <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2">
                    <span className="font-semibold">{s ? s.name : a.service_new}</span>
                    {s && (
                      <span className="text-[13px] text-muted">
                        {t(a.minutes, { n: s.duration })}
                        {s.capacity > 1 ? ` · ${t(a.capacity_n, { n: s.capacity })}` : ""}
                        {!s.active ? ` · ${a.inactive}` : ""}
                      </span>
                    )}
                  </summary>
                  <form action={saveService} className="mt-3 flex flex-col gap-3">
                    {hidden({ part: "services", ...(s ? { service_id: s.id } : {}) })}
                    <Field label={a.service_name}>
                      <input name="name" required maxLength={80} defaultValue={s?.name ?? ""} disabled={ro} className={inputClass} />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label={a.service_duration}>
                        <input type="number" name="duration" required min={5} max={480} defaultValue={s?.duration ?? 30} disabled={ro} className={inputClass} />
                      </Field>
                      <Field label={a.service_capacity}>
                        <input type="number" name="capacity" min={1} max={500} defaultValue={s?.capacity ?? 1} disabled={ro} className={inputClass} />
                      </Field>
                      <Field label={a.service_buffer_before}>
                        <input type="number" name="buffer_before" min={0} max={120} defaultValue={s?.buffer_before ?? 0} disabled={ro} className={inputClass} />
                      </Field>
                      <Field label={a.service_buffer_after}>
                        <input type="number" name="buffer_after" min={0} max={120} defaultValue={s?.buffer_after ?? 0} disabled={ro} className={inputClass} />
                      </Field>
                    </div>
                    <Field label={a.service_note}>
                      <input name="note" maxLength={300} defaultValue={s?.note ?? ""} disabled={ro} className={inputClass} />
                    </Field>
                    <label className="flex min-h-11 items-center gap-3 text-[15px]">
                      <input type="checkbox" name="active" defaultChecked={s?.active ?? true} disabled={ro} className={check} /> {a.service_active}
                    </label>
                    <label className="flex min-h-11 items-center gap-3 text-[15px]">
                      <input type="checkbox" name="offered_by_assistant" defaultChecked={s?.offered_by_assistant ?? true} disabled={ro} className={check} /> {a.service_assistant}
                    </label>
                    {setup.resources.length > 0 && (
                      <fieldset className="flex flex-col gap-1">
                        <legend className="text-sm">{a.service_resources}</legend>
                        <label className="flex min-h-11 items-center gap-3 text-[15px]">
                          <input type="checkbox" name="needs_resource" defaultChecked={s?.needs_resource ?? false} disabled={ro} className={check} /> {a.service_needs_resource}
                        </label>
                        {setup.resources.map((r) => (
                          <label key={r.id} className="flex min-h-11 items-center gap-3 pl-8 text-[15px]">
                            <input type="checkbox" name="resource_ids" value={r.id} defaultChecked={s?.resource_ids.includes(r.id) ?? false} disabled={ro} className={check} />
                            {r.name} <span className="text-muted">· {kindLabel(r.kind)}</span>
                          </label>
                        ))}
                      </fieldset>
                    )}
                    {planActive && <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>}
                  </form>
                  {s && planActive && (
                    <form action={removeService} className="mt-2">
                      {hidden({ part: "services", service_id: s.id })}
                      <button type="submit" className="min-h-11 text-sm underline underline-offset-4">
                        {a.remove}
                      </button>
                    </form>
                  )}
                </details>
              ),
            )}
          </section>

          {/* Zdroje */}
          <section id="resources" className={card} data-settings-part="resources">
            <h2 className="text-[17px] font-bold">{a.resources_title}</h2>
            <p className="text-sm text-muted">{a.resources_intro}</p>
            {notice("resources")}
            {[...setup.resources, null].map((r) =>
              r === null && !planActive ? null : (
                <details key={r?.id ?? "new"} className="rounded-[10px] border border-line p-3" data-resource={r?.id ?? "new"}>
                  <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2">
                    <span className="font-semibold">{r ? r.name : a.resource_new}</span>
                    {r && (
                      <span className="text-[13px] text-muted">
                        {kindLabel(r.kind)}
                        {!r.active ? ` · ${a.inactive}` : ""}
                      </span>
                    )}
                  </summary>
                  <form action={saveResource} className="mt-3 flex flex-col gap-3">
                    {hidden({ part: "resources", ...(r ? { resource_id: r.id } : {}) })}
                    <Field label={a.resource_name}>
                      <input name="name" required maxLength={80} defaultValue={r?.name ?? ""} disabled={ro} className={inputClass} />
                    </Field>
                    <Field label={a.resource_kind}>
                      <select name="kind" defaultValue={r?.kind ?? "person"} disabled={ro} className={`${inputClass} bg-white`}>
                        <option value="person">{a.kind_person}</option>
                        <option value="machine">{a.kind_machine}</option>
                        <option value="room">{a.kind_room}</option>
                      </select>
                    </Field>
                    <label className="flex min-h-11 items-center gap-3 text-[15px]">
                      <input type="checkbox" name="active" defaultChecked={r?.active ?? true} disabled={ro} className={check} /> {a.service_active}
                    </label>
                    {setup.services.length > 0 && (
                      <fieldset className="flex flex-col gap-1">
                        <legend className="text-sm">{a.resource_services}</legend>
                        {setup.services.map((s) => (
                          <label key={s.id} className="flex min-h-11 items-center gap-3 text-[15px]">
                            <input type="checkbox" name="service_ids" value={s.id} defaultChecked={r ? s.resource_ids.includes(r.id) : false} disabled={ro} className={check} />
                            {s.name}
                          </label>
                        ))}
                      </fieldset>
                    )}
                    <p className="text-[13px] text-muted">{a.resource_hours_hint}</p>
                    {planActive && <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>}
                  </form>
                  {r && planActive && (
                    <form action={removeResource} className="mt-2">
                      {hidden({ part: "resources", resource_id: r.id })}
                      <button type="submit" className="min-h-11 text-sm underline underline-offset-4">
                        {a.remove}
                      </button>
                    </form>
                  )}
                </details>
              ),
            )}
          </section>

          {/* Blokované časy */}
          <section id="blocks" className={card} data-settings-part="blocks">
            <h2 className="text-[17px] font-bold">{a.blocks_title}</h2>
            <p className="text-sm text-muted">{a.blocks_intro}</p>
            {notice("blocks")}
            {setup.blocks.length === 0 ? (
              <p className="text-sm text-muted">{a.blocks_none}</p>
            ) : (
              <ul className="flex flex-col border-t border-line">
                {setup.blocks.map((x) => (
                  <li key={x.id} className="flex items-center justify-between gap-3 border-b border-line py-2 text-[15px]">
                    <span>
                      {formatDateTime(x.starts_at, lang, tz)} – {formatDateTime(x.ends_at, lang, tz)}
                      <br />
                      <span className="text-[13px] text-muted">
                        {resourceName(x.resource_id)}
                        {x.note ? ` · ${x.note}` : ""}
                      </span>
                    </span>
                    {planActive && (
                      <form action={removeBlock}>
                        {hidden({ part: "blocks", block_id: x.id })}
                        <button type="submit" className="min-h-11 text-sm underline underline-offset-4">
                          {a.remove}
                        </button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {planActive && (
              <form action={saveBlock} className="flex flex-col gap-3 rounded-[10px] border border-line p-3" data-block-new>
                {hidden({ part: "blocks", timezone: tz })}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={a.block_from}>
                    <input type="datetime-local" name="from" required defaultValue={utcToLocalInput(new Date(), tz).slice(0, 11) + "08:00"} className={inputClass} />
                  </Field>
                  <Field label={a.block_to}>
                    <input type="datetime-local" name="to" required defaultValue={utcToLocalInput(new Date(), tz).slice(0, 11) + "12:00"} className={inputClass} />
                  </Field>
                </div>
                {setup.resources.length > 0 && (
                  <Field label={a.block_for}>
                    <select name="resource_id" defaultValue="" className={`${inputClass} bg-white`}>
                      <option value="">{a.block_whole_shop}</option>
                      {setup.resources.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label={a.block_note}>
                  <input name="note" maxLength={200} className={inputClass} />
                </Field>
                <PendingButton pending={dict.owner.saving}>{a.block_add}</PendingButton>
              </form>
            )}
          </section>

          {/* Kalendár: Google (voliteľné) + odkaz pre telefón */}
          <section id="calendar" className={card} data-settings-part="calendar">
            <h2 className="text-[17px] font-bold">{a.calendar_title}</h2>
            <p className="text-sm text-muted">{a.calendar_intro}</p>
            {notice("calendar")}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-[15px]">
              <span>
                <strong>{a.google_title}</strong> <span className="text-muted">({a.optional})</span>
                <br />
                <span className="text-[13px] text-muted">
                  {!googleOn
                    ? a.google_off
                    : !setup.google
                      ? a.google_none
                      : setup.google.status === "ok"
                        ? t(a.google_connected, { date: formatDateTime(setup.google.connected_at, lang, tz) })
                        : (b[`calendar_${setup.google.status}`] ?? a.google_problem)}
                </span>
              </span>
              {googleOn && planActive && (
                <form action={setup.google ? disconnectGoogle : connectGoogle}>
                  {hidden({ view: "settings" })}
                  <button type="submit" className={ghost}>
                    {setup.google ? a.google_disconnect : a.google_connect}
                  </button>
                </form>
              )}
            </div>
            <div className="flex flex-col gap-2 border-t border-line pt-3 text-[15px]">
              <span>
                <strong>{a.feed_title}</strong>
                <br />
                <span className="text-[13px] text-muted">
                  {setup.feed ? t(a.feed_active, { date: formatDateTime(setup.feed.created_at, lang, tz) }) : a.feed_hint}
                </span>
              </span>
              {planActive && (
                <CalendarFeedForm
                  shopId={shop.id}
                  exists={Boolean(setup.feed)}
                  labels={{
                    create: a.feed_create, renew: a.feed_renew, busy: dict.owner.saving, shown_once: a.feed_shown_once,
                    copy: a.copy, copied: a.copied, failed: a.err_failed,
                  }}
                />
              )}
              {setup.feed && (
                <form action={calendarFeedOff}>
                  {hidden({ part: "calendar" })}
                  <button type="submit" className="min-h-11 text-sm underline underline-offset-4">
                    {a.feed_off}
                  </button>
                </form>
              )}
            </div>
          </section>
        </>
      )}

      {/* Súkromné priečinky (their own page) */}
      <section id="folders" className={card} data-settings-part="folders">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[17px] font-bold">{d.private_folders_title}</h2>
          <Link href={`/${lang}/dashboard/assistant/folders?${new URLSearchParams({ shop: shop.slug })}`} className="text-sm underline underline-offset-4">
            {a.manage}
          </Link>
        </div>
        <p className="text-sm text-muted">{a.folders_hint}</p>
      </section>
    </div>
  );
}
