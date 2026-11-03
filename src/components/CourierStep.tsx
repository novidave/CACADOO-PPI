"use client";

import { useRef, useState, type ReactNode } from "react";

/**
 * One courier step (database update 75): "Na ceste", a payment mark, "Doručené", "Problém s donáškou". A real form that
 * posts to /api/kurier/step (works without JavaScript: the route answers with a redirect). With JavaScript it sends the
 * same fields as JSON and, on a weak signal, sends the SAME step again (its UUID was made when the page was drawn) until
 * it gets through — the database applies a step id once, so a retry never counts twice. Then it goes to `next`.
 */
export function CourierStep({
  hidden,
  next,
  back,
  className = "",
  formClassName = "",
  disabled = false,
  labels,
  children,
  fields,
  data,
}: {
  /** fn, lang, order_id, step_id, to?, pay_method? … */
  hidden: Record<string, string | number | null | undefined>;
  /** Where to go after it is saved. */
  next: string;
  /** Where the no-JavaScript answer shows a refusal. */
  back: string;
  className?: string;
  formClassName?: string;
  disabled?: boolean;
  labels: { sending: string; retrying: string; errors: Record<string, string>; failed: string };
  children: ReactNode;
  /** Extra fields drawn inside the form (the cash amount, the problem's reason). */
  fields?: ReactNode;
  data?: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<"idle" | "sending" | "retrying">("idle");
  const [error, setError] = useState<string | null>(null);

  async function send(body: Record<string, unknown>, attempt: number): Promise<void> {
    let res: Response | null = null;
    try {
      res = await fetch("/api/kurier/step", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      res = null;
    }
    if (res && res.ok) {
      window.location.assign(next);
      return;
    }
    if (res && res.status < 500 && res.status !== 429) {
      const answer = (await res.json().catch(() => ({}))) as { error?: string };
      setState("idle");
      setError(labels.errors[answer.error ?? ""] ?? labels.failed);
      if (answer.error === "courier") window.location.assign(next);
      return;
    }
    // no signal, a timeout or a busy server: the same step again, a little later each time (also when back online)
    setState("retrying");
    const wait = [1000, 2000, 4000, 8000, 15000, 30000][Math.min(attempt, 5)];
    await new Promise<void>((resolve) => {
      const onLine = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        window.removeEventListener("online", onLine);
        resolve();
      }, wait);
      window.addEventListener("online", onLine, { once: true });
    });
    return send(body, attempt + 1);
  }

  return (
    <form
      ref={form}
      action="/api/kurier/step"
      method="post"
      className={formClassName}
      data-courier-step={data}
      onSubmit={(e) => {
        e.preventDefault();
        if (state !== "idle" || !form.current) return;
        const body: Record<string, unknown> = {};
        new FormData(form.current).forEach((v, k) => {
          body[k] = typeof v === "string" ? v : "";
        });
        setError(null);
        setState("sending");
        void send(body, 0);
      }}
    >
      {Object.entries({ ...hidden, next, back }).map(([k, v]) =>
        v === null || v === undefined ? null : <input key={k} type="hidden" name={k} value={String(v)} />,
      )}
      {fields}
      <button type="submit" className={className} disabled={disabled || state !== "idle"} aria-busy={state !== "idle"}>
        {state === "sending" ? labels.sending : state === "retrying" ? labels.retrying : children}
      </button>
      {error && (
        <p role="alert" className="text-[15px] text-[#B42318]">
          {error}
        </p>
      )}
    </form>
  );
}
