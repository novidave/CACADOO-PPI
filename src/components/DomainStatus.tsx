"use client";

import { useEffect, useRef, useState } from "react";

type Labels = Record<string, string> & { status: Record<string, string> };

export interface DomainView {
  id: string;
  kind: "bought" | "connected";
  hostname: string;
  site_host: string | null;
  status: string;
  test_mode: boolean;
  dns_records: { type: string; name: string; value: string }[] | null;
  auto_dns: boolean;
  last_check_at: string | null;
  next_check_at: string | null;
  live_at: string | null;
  email_sent: boolean;
  expires_at: string | null;
}

const BOUGHT_STEPS = ["paid", "registering", "configuring", "securing", "live"];
const MOVING = ["checkout", "paid", "registering", "configuring", "securing", "waiting_dns", "verified"];
export const GOOGLE_PROFILE_URL = "https://business.google.com/";

/**
 * The domain's live state: the progress of a bought domain (Zaplatené → … → Hotovo), or the
 * DNS records and "Skontrolovať" of the shop's own domain. When it becomes live while this
 * page is open, the website opens on the new domain after 5 seconds (same tab); the buttons
 * stay for browsers that block it. The shop never sees DNS for a bought domain.
 */
export function DomainStatus({
  initial,
  labels,
  lang,
  timeZone,
  freshFromPayment,
}: {
  initial: DomainView;
  labels: Labels;
  lang: string;
  timeZone: string;
  freshFromPayment: boolean;
}) {
  const [view, setView] = useState(initial);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const sawProgress = useRef(MOVING.includes(initial.status));
  const host = view.site_host ?? view.hostname;
  const url = `https://${host}`;
  const when = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat(lang, { timeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(iso)) : "";

  // Ask for the state while something is moving (every 3 seconds; DNS waits every 15).
  useEffect(() => {
    if (!MOVING.includes(view.status)) return;
    const every = view.status === "waiting_dns" ? 15_000 : 3_000;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/owner/domains/${view.id}`, { cache: "no-store" }).catch(() => null);
      if (res?.ok) setView((await res.json()) as DomainView);
    }, every);
    return () => clearInterval(timer);
  }, [view.id, view.status]);

  // Live now (seen while the page was open, or just after paying): open it after 5 seconds.
  useEffect(() => {
    if (view.status !== "live") return;
    const justNow = view.live_at ? Date.now() - Date.parse(view.live_at) < 120_000 : false;
    if (!sawProgress.current && !(freshFromPayment && justNow)) return;
    sawProgress.current = false;
    let n = 5;
    const start = setTimeout(() => setCountdown(n), 0);
    const timer = setInterval(() => {
      n -= 1;
      setCountdown(n);
      if (n <= 0) {
        clearInterval(timer);
        window.location.href = `https://${view.site_host ?? view.hostname}`;
      }
    }, 1000);
    return () => {
      clearTimeout(start);
      clearInterval(timer);
    };
  }, [view.status, view.live_at, view.site_host, view.hostname, freshFromPayment]);

  async function recheck() {
    setChecking(true);
    setNote(null);
    const res = await fetch(`/api/owner/domains/${view.id}`, { method: "POST" }).catch(() => null);
    setChecking(false);
    if (res?.status === 429) setNote(labels.check_too_soon);
    else if (!res?.ok) setNote(labels.error);
    if (res) {
      const body = (await res.json().catch(() => null)) as DomainView | null;
      if (body?.id) setView(body);
    }
  }

  async function copy(text: string) {
    await navigator.clipboard?.writeText(text).catch(() => null);
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  }

  if (view.status === "live") {
    return (
      <div className="flex flex-col gap-3 border border-foreground p-4" data-domain-live>
        <p className="text-lg font-semibold">{labels.live_title.replace("{domain}", host)}</p>
        {countdown !== null && countdown > 0 && (
          <p role="status" data-countdown>
            {labels.countdown.replace("{n}", String(countdown))}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <a href={url} className="rounded border border-foreground px-4 py-2 font-medium" data-open-site>
            {labels.open_site}
          </a>
          <a href={GOOGLE_PROFILE_URL} target="_blank" rel="noopener" className="rounded border border-line px-4 py-2">
            {labels.google_profile}
          </a>
        </div>
        {view.email_sent && <p className="text-sm text-muted">{labels.email_note}</p>}
        {view.test_mode && <p className="text-sm text-muted">{labels.test_note.replace("{domain}", view.hostname).replace("{site}", host)}</p>}
      </div>
    );
  }

  if (view.kind === "bought") {
    const at = view.status === "checkout" ? -1 : BOUGHT_STEPS.indexOf(view.status);
    return (
      <div className="flex flex-col gap-3 border border-line p-4" data-domain-progress={view.status}>
        <p className="font-semibold">{labels.progress_title.replace("{domain}", view.hostname)}</p>
        {view.status === "checkout" && <p role="status">{labels.waiting_payment}</p>}
        <ol className="flex flex-col gap-1">
          {BOUGHT_STEPS.map((step, i) => (
            <li key={step} className={i < at ? "text-muted" : i === at ? "font-semibold" : "text-muted"} aria-current={i === at ? "step" : undefined}>
              {i < at ? "✓ " : i === at ? "→ " : "· "}
              {labels[`step_${step}`]}
            </li>
          ))}
        </ol>
        {view.test_mode && <p className="text-sm text-muted">{labels.test_mode}</p>}
      </div>
    );
  }

  // The shop's own domain: the records to add, the MX warning, "Skontrolovať".
  return (
    <div className="flex flex-col gap-3 border border-line p-4" data-domain-connect={view.status}>
      <p className="font-semibold">
        {view.hostname} · {labels.status[view.status] ?? view.status}
      </p>
      {view.auto_dns ? (
        <p className="text-sm">{labels.auto_dns}</p>
      ) : (
        <>
          <p className="text-sm">{labels.dns_title}</p>
          {view.dns_records?.length ? (
            <table className="w-full text-sm" data-dns-records>
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="py-1 pr-3 font-normal">{labels.dns_type}</th>
                  <th className="py-1 pr-3 font-normal">{labels.dns_name}</th>
                  <th className="py-1 pr-3 font-normal">{labels.dns_value}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {view.dns_records.map((r) => (
                  <tr key={`${r.type}-${r.name}-${r.value}`} className="border-b border-line">
                    <td className="py-1 pr-3 font-mono">{r.type}</td>
                    <td className="py-1 pr-3 font-mono">{r.name}</td>
                    <td className="break-all py-1 pr-3 font-mono">{r.value}</td>
                    <td className="py-1 text-right">
                      <button type="button" onClick={() => copy(r.value)} className="underline underline-offset-4">
                        {copied === r.value ? labels.dns_copied : labels.dns_copy}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted">{labels.dns_waiting_records}</p>
          )}
          <p className="text-sm font-semibold">{labels.mx_warning}</p>
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={recheck} disabled={checking} className="rounded border border-foreground px-4 py-2 font-medium disabled:text-muted" data-recheck>
          {checking ? labels.checking : labels.check_button}
        </button>
        {note && <span role="status">{note}</span>}
      </div>
      <p className="text-xs text-muted">
        {view.last_check_at && labels.last_check.replace("{time}", when(view.last_check_at))}
        {view.last_check_at && view.next_check_at && " · "}
        {view.next_check_at && labels.next_check.replace("{time}", when(view.next_check_at))}
      </p>
    </div>
  );
}
