"use client";

import { useEffect, useState } from "react";
import type { StatusInput, StatusLabels, StatusState } from "@/lib/hours";
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
}: {
  first: StatusView;
  input: StatusInput;
  labels: StatusLabels;
  lang: string;
  className?: string;
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
