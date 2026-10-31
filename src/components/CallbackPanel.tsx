"use client";

import { useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";

type Labels = Dictionary["chat"];

interface Conversation {
  id: string;
  token: string;
}

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);

/**
 * "Nechajte nám kontakt" (database update 59): after an answer the assistant could not give, the page's own form —
 * never the AI — takes a phone or an e-mail (at least one), an optional name and the consent. The shop gets a contact
 * and an e-mail "Nový zákazník, prosím odpovedzte"; the answer comes by SMS or e-mail from the shop itself.
 */
export function CallbackPanel({
  base,
  shopName,
  conversation,
  privacyHref,
  labels,
}: {
  base: string;
  shopName: string;
  conversation: () => Conversation | null;
  privacyHref: string;
  labels: Labels;
}) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base}/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          phone: form.get("phone"),
          email: form.get("email"),
          consent: form.get("consent") === "on",
          conversation: conversation(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setDone(true);
        return;
      }
      const key = `callback_err_${data.error ?? "failed"}` as keyof Labels;
      setError((labels[key] as string | undefined) ?? labels.callback_err_failed);
    } catch {
      setError(labels.callback_err_failed);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p role="status" className="border border-line p-3 text-sm font-semibold" data-callback-done>
        {fill(labels.callback_done, { shop: shopName })}
      </p>
    );
  }
  const input = "rounded border border-line px-3 py-2 text-base outline-none focus:border-foreground";
  return (
    <div className="flex flex-col gap-3 border border-line p-3" data-callback>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="min-h-11 self-start rounded border border-foreground px-4 text-sm font-medium" data-callback-open>
          {labels.callback_open}
        </button>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(new FormData(e.currentTarget));
          }}
          data-callback-form
        >
          <p className="text-sm">{fill(labels.callback_intro, { shop: shopName })}</p>
          {error && (
            <p role="alert" className="text-sm font-semibold">
              {error}
            </p>
          )}
          <label className="flex flex-col gap-1 text-sm">
            {labels.callback_phone}
            <input name="phone" type="tel" maxLength={40} autoComplete="tel" className={input} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {labels.callback_email}
            <input name="email" type="email" maxLength={254} autoComplete="email" className={input} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {labels.callback_name}
            <input name="name" maxLength={120} autoComplete="name" className={input} />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="consent" required className="mt-1 h-4 w-4 shrink-0 accent-foreground" />
            <span>
              {fill(labels.callback_consent, { shop: shopName })}{" "}
              <a href={privacyHref} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                {labels.booking_privacy}
              </a>
            </span>
          </label>
          <button type="submit" disabled={busy} className="min-h-11 self-start rounded border border-foreground px-4 font-medium disabled:text-muted" data-callback-send>
            {busy ? labels.booking_busy : labels.callback_send}
          </button>
        </form>
      )}
    </div>
  );
}
