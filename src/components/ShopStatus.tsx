"use client";

import { useEffect, useState } from "react";
import { shopStatus, statusParts, type StatusInput, type StatusLabels } from "@/lib/hours";
import { StatusDot } from "./StatusDot";

export { StatusDot } from "./StatusDot";

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
