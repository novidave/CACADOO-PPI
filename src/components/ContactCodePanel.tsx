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
 * Update 63: the assistant needs the shopper's checked mobile to book. The page's own form — never the AI — takes the
 * name, the mobile and the consent, sends a 6-digit SMS code and checks it here; the code never goes into the chat or the
 * conversation. When it is right, the contact is made (or found by the number) and `onVerified` tells the assistant, which
 * then books the chosen time at once (no confirmation SMS).
 */
export function ContactCodePanel({
  base,
  lang,
  shopName,
  conversation,
  privacyHref,
  labels,
  onVerified,
}: {
  base: string;
  lang: string;
  shopName: string;
  conversation: () => Conversation | null;
  privacyHref: string;
  labels: Labels;
  onVerified: () => void;
}) {
  const [code, setCode] = useState<{ id: string; phone: string; test?: string } | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = (reason: string | undefined, left?: number | null) => {
    const key = `contact_err_${reason ?? "failed"}` as keyof Labels;
    const text = (labels[key] as string | undefined) ?? labels.contact_err_failed;
    return left ? `${text} ${fill(labels.contact_attempts_left, { n: String(left) })}` : text;
  };

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`${base}/contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, conversation: conversation(), lang }),
    });
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function start(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post({
        action: "start", purpose: "contact", name: form.get("name"), phone: form.get("phone"), consent: form.get("consent") === "on",
      });
      if (ok && typeof data.id === "string") {
        setCode({ id: data.id, phone: String(data.phone ?? ""), test: typeof data.test_code === "string" ? data.test_code : undefined });
      } else {
        setError(problem(data.error as string | undefined));
      }
    } catch {
      setError(labels.contact_err_failed);
    } finally {
      setBusy(false);
    }
  }

  async function verify(form: FormData) {
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post({ action: "verify", id: code.id, code: String(form.get("code") ?? "") });
      if (ok && data.ok) {
        setDone(true);
        onVerified();
      } else {
        if (data.error === "expired" || data.error === "too_many_attempts" || data.error === "not_found") setCode(null);
        setError(problem(data.error as string | undefined, data.attempts_left as number | null));
      }
    } catch {
      setError(labels.contact_err_failed);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p role="status" className="border border-line p-3 text-sm font-semibold" data-contact-done>
        {labels.contact_verified}
      </p>
    );
  }
  const input = "rounded border border-line px-3 py-2 text-base outline-none focus:border-foreground";
  return (
    <div className="flex flex-col gap-3 border border-line p-3" data-contact-code>
      <p className="text-sm font-semibold">{labels.contact_title}</p>
      {error && (
        <p role="alert" className="text-sm font-semibold">
          {error}
        </p>
      )}
      {!code ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void start(new FormData(e.currentTarget));
          }}
          data-contact-form
        >
          <p className="text-sm">{fill(labels.contact_intro, { shop: shopName })}</p>
          <label className="flex flex-col gap-1 text-sm">
            {labels.contact_name}
            <input name="name" required maxLength={80} autoComplete="name" className={input} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {labels.contact_phone}
            <input name="phone" type="tel" required maxLength={40} autoComplete="tel" className={input} />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="consent" required className="mt-1 h-4 w-4 shrink-0 accent-foreground" />
            <span>
              {fill(labels.contact_consent, { shop: shopName })}{" "}
              <a href={privacyHref} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                {labels.booking_privacy}
              </a>
            </span>
          </label>
          <button type="submit" disabled={busy} className="min-h-11 self-start rounded border border-foreground px-4 font-medium disabled:text-muted" data-contact-send>
            {busy ? labels.booking_busy : labels.contact_send_code}
          </button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void verify(new FormData(e.currentTarget));
          }}
          data-contact-verify
        >
          <p className="text-sm">{fill(labels.contact_sent_to, { phone: code.phone })}</p>
          {code.test && <p className="text-sm text-muted">{fill(labels.contact_test_code, { code: code.test })}</p>}
          <label className="flex flex-col gap-1 text-sm">
            {labels.contact_code_label}
            <input
              name="code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,8}"
              maxLength={8}
              placeholder={labels.contact_code_placeholder}
              className={`${input} tracking-widest`}
            />
          </label>
          <button type="submit" disabled={busy} className="min-h-11 self-start rounded border border-foreground px-4 font-medium disabled:text-muted" data-contact-check>
            {busy ? labels.booking_busy : labels.contact_verify}
          </button>
        </form>
      )}
    </div>
  );
}
