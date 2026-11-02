"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "@/i18n/config";
import { terminalAct } from "@/app/[lang]/(account)/dashboard/sklad/actions";

export type TerminalLabels = Record<
  | "term_connected" | "term_awake" | "term_welcome" | "term_due" | "term_ready" | "term_ready_text" | "term_tx" | "term_tx_line"
  | "term_confirm_text" | "term_paid" | "term_thanks" | "term_saved" | "term_next" | "term_cancel" | "term_offline"
  | "term_divider" | "term_customer" | "term_shop" | "qr_scan_hint" | "qr_waiting" | "qr_alt" | "qr_close" | "err_failed",
  string
>;

interface State {
  state: "standby" | "waiting" | "paid";
  shop: string;
  id?: string;
  total?: string;
  pieces?: string;
  vs?: string;
  created?: string;
  paid?: string | null;
  location?: string;
  svg?: string | null;
}

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);

/** Three rising notes when a payment is confirmed (skipped quietly where the device has no sound). */
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [[784, 0], [1047, 0.13], [1319, 0.26]].forEach(([f, at]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const t = ctx.currentTime + at;
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.45);
    });
    window.setTimeout(() => void ctx.close(), 1000);
  } catch {}
  try {
    navigator.vibrate?.([60, 40, 60]);
  } catch {}
}

/**
 * The QR terminal (database update 68; screen "QR terminál"): a spare phone on the counter, logged in as an owner.
 * The upper half faces the customer (turned upside down): the shop, the amount and the PAY by square code, then the
 * green "Zaplatené". The lower half is the shop's: the transaction, "Zaplatené" / "Zrušiť" (the same SQL as the Predaj
 * screen), "Ďalší zákazník". It reads /api/owner/sklad/terminal every 3 s, keeps the screen on (Wake Lock, where the
 * browser has it) and chimes when a sale is paid — here or on the Predaj screen. Cacaduu never sees the bank.
 */
export function SkladTerminal({ lang, shopId, shopSlug, exitHref, labels: L }: { lang: Locale; shopId: string; shopSlug: string; exitHref: string; labels: TerminalLabels }) {
  const [st, setSt] = useState<State | null>(null);
  const [offline, setOffline] = useState(false);
  const [awake, setAwake] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const lastRef = useRef<State | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/owner/sklad/terminal?${new URLSearchParams({ shop: shopId, lang })}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as State;
      const prev = lastRef.current;
      if (next.state === "paid" && prev?.state === "waiting" && prev.id === next.id) chime();
      lastRef.current = next;
      setSt(next);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [lang, shopId]);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 3000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [load]);

  // keep the screen on while the terminal is open
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    const wake = async () => {
      try {
        const nav = navigator as unknown as { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
        if (!nav.wakeLock || document.visibilityState !== "visible") return;
        lock = await nav.wakeLock.request("screen");
        setAwake(true);
      } catch {
        setAwake(false);
      }
    };
    void wake();
    const onVisible = () => void wake();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => {});
    };
  }, []);

  const act = async (what: "paid" | "cancel") => {
    if (!st?.id || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await terminalAct({ lang, shopId, shopSlug, saleId: st.id, act: what });
      if (!res.ok) setError(L.err_failed);
      await load();
    } catch {
      setError(L.err_failed);
    } finally {
      setBusy(false);
    }
  };

  const shown: State["state"] = !st ? "standby" : st.state === "paid" && dismissed === st.id ? "standby" : st.state;
  const paid = shown === "paid";

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-white" data-sklad-terminal={shown}>
      {/* the customer's half, turned towards them */}
      <section
        aria-label={L.term_customer}
        className={`flex flex-1 rotate-180 flex-col items-center justify-center gap-3 p-6 text-center ${paid ? "bg-[#146C37] text-white" : ""}`}
      >
        {shown === "standby" && (
          <>
            <span aria-hidden="true" className="flex size-14 items-center justify-center rounded-full bg-foreground text-2xl font-bold text-white">
              {(st?.shop ?? "·").slice(0, 1)}
            </span>
            <strong className="text-xl">{st?.shop}</strong>
            <span className="max-w-xs text-muted">{L.term_welcome}</span>
          </>
        )}
        {shown === "waiting" && st && (
          <>
            <span className="text-sm text-muted">{fill(L.term_due, { shop: st.shop })}</span>
            <strong className="text-[40px] leading-none">{st.total}</strong>
            {st.svg && (
              <div
                role="img"
                aria-label={fill(L.qr_alt, { total: st.total ?? "" })}
                className="w-[min(70vw,34vh)] [&>svg]:h-auto [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: st.svg }}
              />
            )}
            <span className="font-semibold">{L.qr_scan_hint}</span>
          </>
        )}
        {paid && st && (
          <div role="status" className="flex flex-col items-center gap-2">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="m7.5 12.5 3 3 6-6.5" />
            </svg>
            <strong className="text-3xl">{L.term_paid}</strong>
            <span className="text-lg">{fill(L.term_thanks, { total: st.total ?? "" })}</span>
          </div>
        )}
      </section>

      <div aria-hidden="true" className="flex items-center gap-2 px-4 text-[12px] text-muted">
        <span className="h-px flex-1 bg-line" />
        <span>{L.term_divider}</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      {/* the shop's half */}
      <section aria-label={L.term_shop} className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
          <span className="flex items-center gap-1.5 font-semibold">
            <span aria-hidden="true" className={`inline-block size-2.5 rounded-full ${offline ? "bg-[#D64545]" : "bg-[#1E9E5A]"}`} />
            {offline ? L.term_offline : L.term_connected}
          </span>
          <span className="flex items-center gap-3">
            {awake && <span className="text-muted">{L.term_awake}</span>}
            <a href={exitHref} className="flex min-h-11 items-center font-semibold underline underline-offset-4">
              {L.qr_close}
            </a>
          </span>
        </div>
        {shown === "standby" && (
          <div className="flex flex-col gap-1">
            <strong className="text-lg">{L.term_ready}</strong>
            <span className="text-sm text-muted">{L.term_ready_text}</span>
          </div>
        )}
        {(shown === "waiting" || paid) && st && (
          <div className={`flex items-center justify-between gap-3 rounded-xl p-3 ${paid ? "bg-[#146C37] text-white" : "bg-[#F2F2F2]"}`}>
            <div className="flex flex-col">
              <span className="text-[13px]">{paid ? L.term_paid : L.term_tx}</span>
              <strong className="font-mono">VS {st.vs}</strong>
              <span className="text-[13px]">{fill(L.term_tx_line, { vs: st.vs ?? "", time: (paid ? st.paid : st.created) ?? "", pieces: st.pieces ?? "" })}</span>
            </div>
            <strong className="text-2xl">{st.total}</strong>
          </div>
        )}
        {shown === "waiting" && (
          <>
            <div role="status" className="flex items-center gap-2 font-bold">
              <span aria-hidden="true" className="inline-block size-3 rounded-full bg-[#F2B705]" />
              {L.qr_waiting}
            </div>
            <span className="text-sm text-muted">{L.term_confirm_text}</span>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" disabled={busy} onClick={() => void act("paid")} className="min-h-14 rounded-xl bg-foreground px-3 text-[17px] font-bold text-white disabled:opacity-50" data-sklad-term-paid>
                {L.term_paid}
              </button>
              <button type="button" disabled={busy} onClick={() => void act("cancel")} className="min-h-14 rounded-xl border border-[#D6D6D6] px-3 text-[17px] font-bold disabled:opacity-50">
                {L.term_cancel}
              </button>
            </div>
          </>
        )}
        {paid && st && (
          <>
            <span className="text-sm">{fill(L.term_saved, { location: st.location ?? "", pieces: st.pieces ?? "" })}</span>
            <button type="button" onClick={() => setDismissed(st.id ?? null)} className="min-h-14 rounded-xl bg-foreground px-3 text-[17px] font-bold text-white">
              {L.term_next}
            </button>
          </>
        )}
        {error && (
          <p role="alert" className="rounded-xl border border-foreground p-3 text-sm font-medium">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
