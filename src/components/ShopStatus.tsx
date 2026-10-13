"use client";

import { useEffect, useState } from "react";
import { shopStatus, STATUS_COLORS, statusParts, type StatusInput, type StatusLabels, type StatusState } from "@/lib/hours";

/**
 * A status dot: the one colour on the site besides the logo, always next to the status in words
 * (never colour alone). White outline and a thin dark ring, so yellow and grey stay visible.
 */
export function StatusDot({ state, size = 10 }: { state: StatusState; size?: number }) {
  return (
    <span
      aria-hidden="true"
      data-status-dot={state}
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: STATUS_COLORS[state],
        border: "2px solid #fff",
        boxShadow: "0 0 0 1px #171717",
        boxSizing: "content-box",
      }}
    />
  );
}

/** The time "now" for a status: the server's render time first, then the browser's clock every minute. */
export function useNow(renderedAt: number): number {
  const [now, setNow] = useState(renderedAt);
  useEffect(() => {
    // Right after load (a cached page must not show an old status for long), then every minute.
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const every = setInterval(tick, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);
  return now;
}

/** "● Otvorené · zatvára o 17:00 · sviatok", computed with the shared rule (src/lib/hours.ts). */
export function LiveStatus({
  input,
  labels,
  lang,
  renderedAt,
  className = "",
}: {
  input: StatusInput;
  labels: StatusLabels;
  lang: string;
  /** Date.now() on the server, so the first render matches. */
  renderedAt: number;
  className?: string;
}) {
  const now = useNow(renderedAt);
  const status = shopStatus(input, new Date(now));
  const parts = statusParts(status, labels, lang);
  return (
    <span className={`inline-flex flex-wrap items-center gap-x-1.5 ${className}`} data-status={status.state}>
      <StatusDot state={status.state} />
      <span className="font-semibold">{parts.main}</span>
      {parts.detail && <span className="text-muted">· {parts.detail}</span>}
      {parts.label && (
        <span className="rounded border border-line px-1 text-xs" data-status-label>
          {parts.label}
        </span>
      )}
    </span>
  );
}
