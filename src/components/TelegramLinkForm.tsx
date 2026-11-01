"use client";

import { useActionState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import type { TelegramLinkState } from "@/app/[lang]/(account)/dashboard/ai/actions";

/**
 * "Prepojte svoj Telegram" (database update 66): a one-time link (10 minutes, once) as a button and a QR code for
 * the phone. The code itself is never shown as text; only its hash is kept in the database.
 */
export function TelegramLinkForm({
  action,
  bot,
  labels,
  lang,
}: {
  action: (previous: TelegramLinkState, formData: FormData) => Promise<TelegramLinkState>;
  bot: string;
  labels: Dictionary["owner_tg"];
  lang: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const texts = labels as Record<string, string>;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-telegram-link>
      {state.error && <p className="border border-line p-3 text-sm">{texts[state.error] ?? labels.err_failed}</p>}
      {state.url && state.qr ? (
        <div className="flex flex-col items-start gap-3 border border-foreground p-3" role="status">
          <a
            href={state.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center rounded border border-foreground px-4 font-medium"
            data-telegram-open
          >
            {labels.open_bot.replace("{bot}", bot)}
          </a>
          {/* eslint-disable-next-line @next/next/no-img-element -- a generated SVG data address, never optimised */}
          <img src={state.qr} alt={labels.qr_alt} width={200} height={200} className="h-[200px] w-[200px] border border-line bg-white" data-telegram-qr />
          <p className="text-xs text-muted">
            {/* the code's end in the owner's own clock (the device that scans it), not a shop time */}
            {labels.valid_until.replace("{time}", state.expiresAt ? new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" }).format(new Date(state.expiresAt)) : "")}
          </p>
        </div>
      ) : null}
      <form action={formAction}>
        <button type="submit" disabled={pending} className="min-h-11 rounded border border-foreground px-4 font-medium disabled:opacity-60" data-telegram-create>
          {pending ? labels.creating : labels.create_link}
        </button>
      </form>
    </div>
  );
}
