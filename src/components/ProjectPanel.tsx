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
 * Update 95: the shopper asked about their own project (my_project said "verify"). The page's own form — never the
 * AI — takes the mobile number and sends an SMS code (only a contact of the shop with a checked number and an enabled
 * project gets one; every number sees the same answer), then checks the code: the website keeps this conversation's
 * session in an HttpOnly cookie and `onUnlocked` asks the question again. The number and the code never go into the
 * chat or the conversation.
 */
export function ProjectPanel({
  base,
  lang,
  conversation,
  labels,
  onUnlocked,
}: {
  base: string;
  lang: string;
  conversation: () => Conversation | null;
  labels: Labels;
  onUnlocked: () => void;
}) {
  const [code, setCode] = useState<{ id: string; phone: string; test?: string } | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = (reason: unknown, left?: unknown) => {
    const text = (labels[`project_err_${String(reason ?? "failed")}` as keyof Labels] as string | undefined) ?? labels.project_err_failed;
    return typeof left === "number" && left > 0 ? `${text} ${fill(labels.project_attempts_left, { n: String(left) })}` : text;
  };

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`${base}/project`, {
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
      const { ok, data } = await post({ action: "code", phone: form.get("phone") });
      if (ok && typeof data.id === "string") {
        setCode({ id: data.id, phone: String(data.phone ?? ""), test: typeof data.test_code === "string" ? data.test_code : undefined });
      } else {
        setError(problem(data.error));
      }
    } catch {
      setError(labels.project_err_failed);
    } finally {
      setBusy(false);
    }
  }

  async function unlock(form: FormData) {
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post({ action: "unlock", id: code.id, code: String(form.get("code") ?? "") });
      if (ok && data.ok) {
        setDone(true);
        onUnlocked();
      } else {
        if (data.error !== "wrong") setCode(null);
        setError(problem(data.error, data.attempts_left));
      }
    } catch {
      setError(labels.project_err_failed);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p role="status" className="border border-line p-3 text-sm font-semibold" data-project-open>
        {labels.project_opened}
      </p>
    );
  }
  const input = "rounded border border-line px-3 py-2 text-base outline-none focus:border-foreground";
  const button = "min-h-11 self-start rounded border border-foreground px-4 font-medium disabled:text-muted";
  return (
    <div className="flex flex-col gap-3 border border-line p-3" data-project-panel>
      <p className="text-sm font-semibold">{labels.project_title}</p>
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
          data-project-phone-form
        >
          <p className="text-sm">{labels.project_intro}</p>
          <label className="flex flex-col gap-1 text-sm">
            {labels.project_phone}
            <input name="phone" type="tel" required maxLength={40} autoComplete="tel" className={input} />
          </label>
          <button type="submit" disabled={busy} className={button} data-project-send>
            {busy ? labels.booking_busy : labels.project_send}
          </button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void unlock(new FormData(e.currentTarget));
          }}
          data-project-code-form
        >
          <p className="text-sm">{fill(labels.project_sent, { phone: code.phone })}</p>
          {code.test && <p className="text-sm text-muted" data-project-test-code>{fill(labels.project_test_code, { code: code.test })}</p>}
          <label className="flex flex-col gap-1 text-sm">
            {labels.project_code}
            <input
              name="code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,8}"
              maxLength={8}
              className={`${input} tracking-widest`}
            />
          </label>
          <button type="submit" disabled={busy} className={button} data-project-unlock>
            {busy ? labels.booking_busy : labels.project_open}
          </button>
        </form>
      )}
    </div>
  );
}
