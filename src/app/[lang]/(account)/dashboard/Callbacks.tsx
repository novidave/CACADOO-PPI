import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { formatDateTime } from "@/lib/format";
import { PendingButton } from "@/components/PendingButton";
import { markCallback } from "./callbackActions";

export interface CallbackRow {
  conversation_id: string;
  callback_at: string;
  answered_at: string | null;
  name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  question: string | null;
}

/** owner_callbacks() (database update 59): null before it or when it cannot be read. */
export async function loadCallbacks(supabase: SupabaseClient, shopId: string): Promise<CallbackRow[] | null> {
  const { data, error } = await supabase.rpc("owner_callbacks", { p_shop_id: shopId, p_limit: 50 });
  return error ? null : ((data ?? []) as CallbackRow[]);
}

/**
 * "Čakajú na odpoveď" on the Konverzácie tab: shoppers who left a phone or e-mail after a question the assistant
 * could not answer (newest waiting first, answered ones of the last 30 days below). "Odpovedať" opens the contact's
 * Správy (SMS or e-mail; a sent answer marks it answered by itself); "Vybavené" marks it by hand.
 */
export function Callbacks({
  rows,
  lang,
  timeZone,
  dict,
  hidden,
}: {
  rows: CallbackRow[];
  lang: Locale;
  timeZone: string;
  dict: Dictionary;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
}) {
  const c = dict.callbacks;
  if (rows.length === 0) return null;
  const waiting = rows.filter((r) => !r.answered_at).length;
  return (
    <section className="flex flex-col gap-3 border border-foreground p-3" aria-labelledby="callbacks-heading" data-callbacks>
      <h3 id="callbacks-heading" className="font-semibold">
        {c.title} <span className="font-normal text-muted">· {t(c.count, { n: waiting })}</span>
      </h3>
      <ul className="flex flex-col divide-y divide-line">
        {rows.map((r) => {
          const who = r.contact_name || r.name || r.phone || r.email || c.no_name;
          return (
            <li key={r.conversation_id} className="flex flex-col gap-1 py-2" data-callback={r.conversation_id} data-answered={Boolean(r.answered_at)}>
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className={r.answered_at ? "text-muted" : "font-semibold"}>{who}</span>
                <span className="text-xs text-muted">{formatDateTime(r.callback_at, lang, timeZone)}</span>
                <span className="text-xs font-semibold">{r.answered_at ? c.answered : c.waiting}</span>
              </span>
              {r.question && <span className="text-sm">„{r.question}“</span>}
              <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                {r.phone && <a href={`tel:${r.phone}`} className="underline underline-offset-4">{r.phone}</a>}
                {r.email && <a href={`mailto:${r.email}`} className="break-all underline underline-offset-4">{r.email}</a>}
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                {r.contact_id && (
                  <Link href={`/${lang}/dashboard/contacts/${r.contact_id}?tab=messages`} className="font-medium underline underline-offset-4" data-callback-reply>
                    {c.reply}
                  </Link>
                )}
                <Link href={`/${lang}/dashboard/conversations/${r.conversation_id}`} className="underline underline-offset-4">
                  {c.open}
                </Link>
                <form action={markCallback}>
                  {hidden({ conversation_id: r.conversation_id, done: r.answered_at ? "0" : "1" })}
                  <PendingButton pending={dict.owner.saving}>{r.answered_at ? c.reopen : c.done}</PendingButton>
                </form>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
