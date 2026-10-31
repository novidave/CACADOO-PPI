"use client";

import { useEffect, useState } from "react";
import type { StatusInput, StatusLabels, StatusState } from "@/lib/hours";
import { STATUS_PILLS } from "@/lib/statusColors";
import { StatusDot } from "./StatusDot";

export interface StatusView {
  state: StatusState;
  main: string;
  detail: string | null;
  label: string | null;
}

/**
 * The status line of a server page ("● Otvorené · zatvára o 17:00"): written on the server (`ShopStatusLine`), then
 * refreshed in the browser right after load and every minute with the shared rule — whose code (@/lib/hours) loads only
 * then, not with the page (the shop page's first JavaScript budget).
 */
export function LiveStatusLazy({
  first,
  input,
  labels,
  lang,
  className = "",
  pill = false,
}: {
  first: StatusView;
  input: StatusInput;
  labels: StatusLabels;
  lang: string;
  className?: string;
  /** the opening hours card's pill (Screen 11): "● Otvorené · zatvára o 17:00" on the status's pale colour */
  pill?: boolean;
}) {
  const [view, setView] = useState(first);
  useEffect(() => {
    let every: ReturnType<typeof setInterval> | null = null;
    let alive = true;
    void import("@/lib/hours").then(({ shopStatus, statusParts }) => {
      if (!alive) return;
      const tick = () => {
        const status = shopStatus(input, new Date());
        setView({ state: status.state, ...statusParts(status, labels, lang) });
      };
      tick();
      every = setInterval(tick, 60_000);
    });
    return () => {
      alive = false;
      if (every) clearInterval(every);
    };
  }, [input, labels, lang]);
  if (pill) {
    const colors = STATUS_PILLS[view.state];
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${className}`}
        style={{ background: colors.bg, color: colors.fg }}
        data-status={view.state}
        data-status-pill
      >
        <StatusDot state={view.state} size={8} />
        <span>{[view.main, view.detail, view.label].filter(Boolean).join(" · ")}</span>
      </span>
    );
  }
  return (
    <span className={`inline-flex flex-wrap items-center gap-x-1.5 ${className}`} data-status={view.state}>
      <StatusDot state={view.state} />
      <span className="font-semibold">{view.main}</span>
      {view.detail && <span className="text-muted">· {view.detail}</span>}
      {view.label && (
        <span className="rounded border border-line px-1 text-xs" data-status-label>
          {view.label}
        </span>
      )}
    </span>
  );
}
