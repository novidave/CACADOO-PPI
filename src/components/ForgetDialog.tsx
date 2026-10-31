"use client";

import { useEffect, useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";

type Labels = Dictionary["chat"];

/**
 * "Vymazať moje údaje" (update 63, the Zakaznik screen): "Len túto konverzáciu" (as before: this conversation and its
 * files) or "Všetko o mne" — every conversation and file of the shopper's number in this shop, the contact, and the
 * future bookings cancelled; confirmed with an SMS code to that number. The shop gets one e-mail (copies in its own
 * cloud or PC folder are the shop's to delete). Nothing can be undone.
 */
export function ForgetDialog({
  base,
  lang,
  shopName,
  hasConversation,
  labels,
  onOnlyThis,
  onDone,
  onClose,
}: {
  base: string;
  lang: string;
  shopName: string;
  hasConversation: boolean;
  labels: Labels;
  onOnlyThis: () => Promise<boolean>;
  onDone: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<"this" | "all">(hasConversation ? "this" : "all");
  const [code, setCode] = useState<{ id: string; phone: string; test?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const problem = (reason: unknown) => {
    const key = `contact_err_${typeof reason === "string" ? reason : "failed"}` as keyof Labels;
    return (labels[key] as string | undefined) ?? labels.contact_err_failed;
  };

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`${base}/contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, lang }),
    });
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function sendCode(phone: string) {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post({ action: "start", purpose: "delete_all", phone });
      if (ok && typeof data.id === "string") {
        setCode({ id: data.id, phone: String(data.phone ?? ""), test: typeof data.test_code === "string" ? data.test_code : undefined });
      } else setError(problem(data.error));
    } catch {
      setError(labels.contact_err_failed);
    } finally {
      setBusy(false);
    }
  }

  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      if (mode === "this") {
        if (await onOnlyThis()) onDone();
        else setError(labels.delete_failed);
        return;
      }
      if (!code) return;
      const verified = await post({ action: "verify", purpose: "delete_all", id: code.id, code: String(form.get("code") ?? "") });
      if (!verified.ok || !verified.data.ok) {
        if (["expired", "too_many_attempts", "not_found"].includes(String(verified.data.error))) setCode(null);
        setError(problem(verified.data.error));
        return;
      }
      const forgotten = await post({ action: "forget", id: code.id });
      if (!forgotten.ok) {
        setError(problem(forgotten.data.error));
        return;
      }
      onDone();
    } catch {
      setError(labels.contact_err_failed);
    } finally {
      setBusy(false);
    }
  }

  const input = "min-h-12 rounded-[10px] border border-[#D6D6D6] px-3 text-base outline-none focus:border-foreground";
  const option = (value: "this" | "all", title: string, hint: string) => (
    <label className={`flex items-start gap-3 rounded-xl p-3.5 text-[15px] ${mode === value ? "border-2 border-foreground" : "border border-[#D6D6D6]"}`}>
      <input
        type="radio"
        name="forget"
        value={value}
        checked={mode === value}
        disabled={value === "this" && !hasConversation}
        onChange={() => setMode(value)}
        className="m-0 h-[22px] w-[22px] shrink-0 accent-foreground"
      />
      <span className="flex flex-col gap-1">
        <strong>{title}</strong>
        <span className="text-sm text-[#5C5C5C]">{hint}</span>
      </span>
    </label>
  );

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="forget-title"
      className="ppi-sheet m-0 mt-auto w-full max-w-none rounded-t-[18px] bg-white p-0 text-foreground backdrop:bg-black/35 sm:m-auto sm:max-w-md sm:rounded-[18px]"
      data-forget-dialog
    >
      <form
        className="flex flex-col gap-3.5 px-4 pb-6 pt-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(new FormData(e.currentTarget));
        }}
      >
        <div className="flex items-center justify-between">
          <h2 id="forget-title" className="m-0 text-xl font-bold">
            {labels.forget_title}
          </h2>
          <button type="button" aria-label={labels.forget_close} onClick={() => dialog.current?.close()} className="flex h-11 w-11 items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <p className="m-0 text-sm text-[#5C5C5C]">{labels.forget_shop.replace("{shop}", shopName)}</p>
        {option("this", labels.forget_only_this, labels.forget_only_this_hint)}
        {option("all", labels.forget_all, labels.forget_all_hint)}
        {mode === "all" && (
          <div className="flex flex-col gap-1.5">
            {!code ? (
              <>
                <label htmlFor="forget-phone" className="text-sm font-semibold">
                  {labels.forget_phone}
                </label>
                <div className="flex gap-2">
                  <input id="forget-phone" name="phone" type="tel" maxLength={40} autoComplete="tel" className={`${input} min-w-0 flex-1`} />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(e) => void sendCode(String(new FormData(e.currentTarget.form!).get("phone") ?? ""))}
                    className="min-h-12 rounded-[10px] border border-[#D6D6D6] px-4 text-sm font-semibold disabled:text-muted"
                    data-forget-send
                  >
                    {labels.forget_send_code}
                  </button>
                </div>
              </>
            ) : (
              <>
                <label htmlFor="forget-code" className="text-sm font-semibold">
                  {labels.forget_code_label}
                </label>
                <p className="m-0 text-sm text-[#5C5C5C]">{labels.contact_sent_to.replace("{phone}", code.phone)}</p>
                {code.test && <p className="m-0 text-sm text-[#5C5C5C]">{labels.contact_test_code.replace("{code}", code.test)}</p>}
                <input
                  id="forget-code"
                  name="code"
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  placeholder={labels.contact_code_placeholder}
                  className={`${input} font-semibold tracking-[2px]`}
                />
              </>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="m-0 text-sm font-semibold">
            {error}
          </p>
        )}
        <p className="m-0 text-[13px] text-[#5C5C5C]">{labels.forget_note}</p>
        <button
          type="submit"
          disabled={busy || (mode === "all" && !code)}
          className="min-h-12 rounded-[10px] border border-foreground bg-foreground px-4 text-base font-semibold text-white disabled:opacity-50"
          data-forget-submit
        >
          {mode === "all" ? labels.forget_submit_all : labels.forget_submit_this}
        </button>
        <button type="button" onClick={() => dialog.current?.close()} className="min-h-12 rounded-[10px] border border-[#D6D6D6] px-4 text-base font-semibold">
          {labels.forget_cancel}
        </button>
      </form>
    </dialog>
  );
}
