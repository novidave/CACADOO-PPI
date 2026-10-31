"use client";

import { useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";

type Labels = Dictionary["chat"];

interface Slot {
  starts_at: string;
  ends_at: string;
}

interface Conversation {
  id: string;
  token: string;
}

type Step =
  | { kind: "pick" }
  | { kind: "form"; slot: Slot }
  | { kind: "code"; slot: Slot; id: string; token: string; phone: string; testCode: string | null }
  | { kind: "done"; slot: Slot };

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

/**
 * Booking in the shop assistant (database update 57): the free times the answer offered as buttons, then this page's
 * own form — name, mobile, optional e-mail, address and note, the consent — never through the AI. The bookings
 * function sends a 6-digit SMS code; the right code confirms at once (no confirmation SMS). Every check (free time,
 * opening hours, no overlap, the shop's Google Calendar, the code's 10 minutes and 5 tries) is on the server.
 */
export function BookingPanel({
  base,
  lang,
  shopName,
  timeZone,
  service,
  slots,
  conversation,
  privacyHref,
  labels,
}: {
  base: string;
  lang: string;
  shopName: string;
  timeZone: string;
  service: string | null;
  slots: Slot[];
  conversation: () => Conversation | null;
  privacyHref: string;
  labels: Labels;
}) {
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const when = (slot: Slot) =>
    new Intl.DateTimeFormat(lang, { timeZone, weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }).format(
      new Date(slot.starts_at),
    );
  const errorText = (reason: string | undefined, attempts?: number | null) => {
    const key = `booking_err_${reason ?? "failed"}` as keyof Labels;
    const text = (labels[key] as string | undefined) ?? labels.booking_err_failed;
    return fill(text, { n: attempts ?? 0 });
  };

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`${base}/booking`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, data };
  }

  async function start(form: FormData, slot: Slot) {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post({
        action: "start",
        lang,
        starts_at: slot.starts_at,
        name: form.get("name"),
        phone: form.get("phone"),
        email: form.get("email"),
        address: form.get("address"),
        note: form.get("note"),
        consent: form.get("consent") === "on",
        conversation: conversation(),
      });
      if (!ok) {
        setError(errorText(String(data.error ?? "failed")));
        if (data.error === "slot_taken") setStep({ kind: "pick" });
        return;
      }
      setStep({
        kind: "code",
        slot,
        id: String(data.id),
        token: String(data.token),
        phone: String(data.phone ?? ""),
        testCode: typeof data.test_code === "string" ? data.test_code : null,
      });
    } catch {
      setError(labels.booking_err_failed);
    } finally {
      setBusy(false);
    }
  }

  async function verify(form: FormData, s: Extract<Step, { kind: "code" }>) {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post({ action: "verify", id: s.id, token: s.token, code: form.get("code") });
      if (ok) {
        setStep({ kind: "done", slot: s.slot });
        return;
      }
      setError(errorText(String(data.error ?? "failed"), typeof data.attempts_left === "number" ? data.attempts_left : null));
      if (data.error !== "wrong_code") setStep({ kind: "pick" });
    } catch {
      setError(labels.booking_err_failed);
    } finally {
      setBusy(false);
    }
  }

  async function resend(s: Extract<Step, { kind: "code" }>) {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post({ action: "resend", id: s.id, token: s.token });
      if (!ok) setError(errorText(String(data.error ?? "failed")));
      else setStep({ ...s, testCode: typeof data.test_code === "string" ? data.test_code : null });
    } finally {
      setBusy(false);
    }
  }

  const input = "rounded border border-line px-3 py-2 text-base outline-none focus:border-foreground";
  const button = "min-h-11 rounded border border-foreground px-4 font-medium disabled:text-muted";

  return (
    <div className="flex flex-col gap-3 border border-line p-3" data-booking={step.kind}>
      {error && (
        <p role="alert" className="text-sm font-semibold" data-booking-error>
          {error}
        </p>
      )}

      {step.kind === "pick" && (
        <>
          <p className="text-sm">{labels.booking_pick}</p>
          <ul className="flex flex-wrap gap-2">
            {slots.map((slot) => (
              <li key={slot.starts_at}>
                <button type="button" onClick={() => setStep({ kind: "form", slot })} className="min-h-11 rounded border border-line px-3 text-sm" data-slot={slot.starts_at}>
                  {when(slot)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {step.kind === "form" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void start(new FormData(e.currentTarget), step.slot);
          }}
          data-booking-form
        >
          <p className="font-semibold">
            {fill(labels.booking_form_title, { time: when(step.slot) })}
            {service && <span className="font-normal text-muted"> · {service}</span>}
          </p>
          <label className="flex flex-col gap-1 text-sm">
            {labels.booking_name}
            <input name="name" required maxLength={120} autoComplete="name" className={input} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {labels.booking_phone}
            <input name="phone" type="tel" required maxLength={40} autoComplete="tel" className={input} />
            <span className="text-xs text-muted">{labels.booking_phone_hint}</span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {labels.booking_email}
            <input name="email" type="email" maxLength={254} autoComplete="email" className={input} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {labels.booking_address}
            <input name="address" maxLength={300} autoComplete="street-address" className={input} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {labels.booking_note}
            <textarea name="note" rows={2} maxLength={500} className={input} />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="consent" required className="mt-1 h-4 w-4 shrink-0 accent-foreground" />
            <span>
              {fill(labels.booking_consent, { shop: shopName })}{" "}
              <a href={privacyHref} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                {labels.booking_privacy}
              </a>
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={button} data-booking-send>
              {busy ? labels.booking_busy : labels.booking_send_code}
            </button>
            <button type="button" onClick={() => setStep({ kind: "pick" })} className="min-h-11 px-2 text-sm underline underline-offset-4">
              {labels.booking_back}
            </button>
          </div>
        </form>
      )}

      {step.kind === "code" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void verify(new FormData(e.currentTarget), step);
          }}
          data-booking-code
        >
          <p className="text-sm" role="status">
            {fill(labels.booking_code_sent, { phone: step.phone })}
          </p>
          {step.testCode && (
            <p className="text-sm font-semibold" data-booking-test-code>
              {fill(labels.booking_test_code, { code: step.testCode })}
            </p>
          )}
          <label className="flex flex-col gap-1 text-sm">
            {labels.booking_code}
            <input
              name="code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,8}"
              maxLength={8}
              className={`${input} w-40 tracking-widest`}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={button} data-booking-confirm>
              {busy ? labels.booking_busy : labels.booking_confirm}
            </button>
            <button type="button" disabled={busy} onClick={() => void resend(step)} className="min-h-11 px-2 text-sm underline underline-offset-4">
              {labels.booking_resend}
            </button>
          </div>
        </form>
      )}

      {step.kind === "done" && (
        <p role="status" className="font-semibold" data-booking-done>
          {fill(labels.booking_done, { when: when(step.slot) })}
          {service && <span className="font-normal"> · {service}</span>}
        </p>
      )}
    </div>
  );
}
