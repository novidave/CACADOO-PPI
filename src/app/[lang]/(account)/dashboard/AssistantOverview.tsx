import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { localMidnight, shopToday } from "@/lib/bookingTools";
import { assistantTabUrl } from "@/lib/dashboardPages";
import { formatDateTime, formatTime } from "@/lib/format";
import { loadSmsUsage, type SmsUsage as Usage } from "@/lib/smsUsage";
import { SmsUsage } from "@/components/SmsUsage";
import { loadCallbacks, type CallbackRow } from "./Callbacks";

interface NextBooking {
  id: string;
  starts_at: string;
  service_name: string | null;
  name: string | null;
  resource_name: string | null;
}

export interface Overview {
  waiting: CallbackRow[];
  today: { conversations: number | null; bookings: number | null; contacts: number | null; unanswered: number };
  next: NextBooking[] | null;
  sms: Usage | null;
  google: boolean;
}

/** Everything Prehľad shows, read as the owner (RLS and the owner_* functions decide; nothing here is cached). */
export async function loadOverview(supabase: SupabaseClient, shopId: string, timeZone: string): Promise<Overview> {
  const midnight = localMidnight(shopToday(timeZone), timeZone);
  const tomorrow = new Date(midnight.getTime() + 26 * 3_600_000);
  const now = new Date();
  const count = async (q: PromiseLike<{ count: number | null; error: unknown }>) => {
    const { count: n, error } = await q;
    return error ? null : (n ?? 0);
  };
  const [callbacks, conversations, contacts, todayBookings, next, sms, google] = await Promise.all([
    loadCallbacks(supabase, shopId),
    count(supabase.from("assistant_conversations").select("id", { count: "exact", head: true }).eq("shop_id", shopId).gte("started_at", midnight.toISOString())),
    count(supabase.from("shop_contacts").select("id", { count: "exact", head: true }).eq("shop_id", shopId).gte("created_at", midnight.toISOString())),
    supabase.rpc("owner_booking_list", { p_shop_id: shopId, p_from: midnight.toISOString(), p_to: tomorrow.toISOString(), p_status: "confirmed" }),
    supabase.rpc("owner_booking_list", { p_shop_id: shopId, p_from: now.toISOString(), p_to: new Date(now.getTime() + 30 * 86_400_000).toISOString(), p_status: "confirmed" }),
    loadSmsUsage(supabase, shopId),
    supabase.from("booking_google_connections").select("status").eq("shop_id", shopId).maybeSingle(),
  ]);
  const waiting = (callbacks ?? []).filter((c) => !c.answered_at);
  const dayEnd = localMidnight(shopToday(timeZone, new Date(midnight.getTime() + 30 * 3_600_000)), timeZone);
  const todays = todayBookings.error ? null : ((todayBookings.data ?? []) as NextBooking[]).filter((x) => new Date(x.starts_at) < dayEnd);
  return {
    waiting,
    today: { conversations, bookings: todays ? todays.length : null, contacts, unanswered: waiting.length },
    next: next.error ? null : ((next.data ?? []) as NextBooking[]).slice(0, 3),
    sms,
    google: !google.error && (google.data as { status?: string } | null)?.status === "ok",
  };
}

const card = "flex flex-col gap-3 rounded-xl border border-line p-4";

/**
 * Asistent → Prehľad (update 63, the Main screen): who waits for an answer (with "Odpovedať"), today's numbers, the next
 * bookings and this month's SMS. Every number links to its tab.
 */
export function AssistantOverview({
  data,
  lang,
  dict,
  shop,
  timeZone,
}: {
  data: Overview;
  lang: Locale;
  dict: Dictionary;
  shop: string;
  timeZone: string;
}) {
  const a = dict.asst;
  const conversation = (id: string) => `/${lang}/dashboard/conversations/${id}?${new URLSearchParams({ shop })}`;
  const tiles: { n: number | null; label: string; href: string }[] = [
    { n: data.today.conversations, label: a.today_conversations, href: assistantTabUrl(lang, "conversations", shop) },
    { n: data.today.bookings, label: a.today_bookings, href: assistantTabUrl(lang, "bookings", shop) },
    { n: data.today.contacts, label: a.today_contacts, href: assistantTabUrl(lang, "contacts", shop) },
    { n: data.today.unanswered, label: a.today_unanswered, href: assistantTabUrl(lang, "conversations", shop) },
  ];
  return (
    <div className="flex flex-col gap-4" data-tab-panel="overview">
      {data.waiting.length > 0 && (
        <section className="flex flex-col gap-3 rounded-xl border-2 border-foreground p-4" data-overview-waiting>
          <div className="flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 8v5M12 16.5v.5" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            <h2 className="text-[17px] font-bold">{t(a.waiting_title, { n: data.waiting.length })}</h2>
          </div>
          <p className="text-sm text-muted">{a.waiting_intro}</p>
          <ul className="flex flex-col border-t border-line">
            {data.waiting.slice(0, 5).map((w) => (
              <li key={w.conversation_id} className="flex items-center justify-between gap-2 border-b border-line py-2.5 last:border-b-0">
                <span className="flex min-w-0 flex-col">
                  <span className="text-[15px] font-bold">{w.contact_name ?? w.name ?? a.no_name}</span>
                  <span className="truncate text-[13px] text-muted">
                    {w.question ? `„${w.question}“ · ` : ""}
                    {formatDateTime(w.callback_at, lang, timeZone)}
                  </span>
                </span>
                <Link href={conversation(w.conversation_id)} className="flex min-h-11 flex-none items-center rounded-[10px] border border-foreground px-4 text-[15px] font-semibold">
                  {a.reply}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2.5" data-overview-today>
        <h2 className="text-[17px] font-bold">{a.today}</h2>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {tiles.map((tile) => (
            <Link key={tile.label} href={tile.href} className="flex flex-col gap-0.5 rounded-xl border border-line p-4">
              <span className="text-[26px] font-bold">{tile.n ?? "–"}</span>
              <span className="text-[13px] text-muted">{tile.label}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className={card} data-overview-next>
        <div className="flex items-baseline justify-between">
          <h2 className="text-[17px] font-bold">{a.next_title}</h2>
          <Link href={assistantTabUrl(lang, "bookings", shop)} className="text-sm underline underline-offset-4">
            {a.all}
          </Link>
        </div>
        {!data.next ? (
          <p className="text-sm text-muted">{a.setup_unavailable}</p>
        ) : data.next.length === 0 ? (
          <p className="text-sm text-muted">{a.next_none}</p>
        ) : (
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2.5 text-[15px]">
            {data.next.map((x) => (
              <span key={x.id} className="contents">
                <strong>{formatTime(new Date(x.starts_at), timeZone)}</strong>
                <span>
                  {[x.service_name, x.name].filter(Boolean).join(" · ")}
                  <span className="text-[13px] text-muted"> · {formatDateTime(x.starts_at, lang, timeZone).replace(/\s*\d{1,2}:\d{2}$/, "")}</span>
                </span>
              </span>
            ))}
          </div>
        )}
        <p className="text-[13px] text-muted">{data.google ? a.source_google : a.source_cacaduu}</p>
      </section>

      {data.sms && (
        <section className={card} data-overview-sms>
          <SmsUsage usage={data.sms} lang={lang} timeZone={timeZone} dict={dict} />
        </section>
      )}
    </div>
  );
}
