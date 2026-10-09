"use client";

import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "ppi.dashboard.open";
const PHONE = "(max-width: 767px)";

function setFromCode(el: HTMLDetailsElement | null, open: boolean, fromCode: { current: boolean }) {
  if (!el || el.open === open) return;
  fromCode.current = true;
  el.open = open;
}

function saved(): Record<string, boolean> {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/**
 * One main section of Môj obchod as a dropdown: heading plus a short summary line while
 * closed. On a phone only the first section starts open, on a computer all of them; what
 * the owner opens or closes is remembered on this device. The section a form was sent from
 * (?at=… / #…) always opens, so its message is seen.
 */
export function DashboardSection({
  id,
  title,
  summary,
  first = false,
  forceOpen = false,
  children,
}: {
  id: string;
  title: string;
  summary?: string | null;
  first?: boolean;
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  // Opening or closing from code is not the owner's choice: not remembered.
  const fromCode = useRef(false);
  // The server's first state only; after that the owner (and the effect below) decide.
  const [initiallyOpen] = useState(first || forceOpen);

  // First show: the section a link points to (#…), else the owner's choice on this device,
  // else the device default.
  useEffect(() => {
    const choice = saved()[id];
    const wanted =
      window.location.hash === `#${id}` ||
      (typeof choice === "boolean" ? choice : first || !window.matchMedia(PHONE).matches);
    setFromCode(ref.current, wanted, fromCode);
  }, [id, first]);

  // A form of this section was just sent: open it so its message is seen.
  useEffect(() => {
    if (forceOpen) setFromCode(ref.current, true, fromCode);
  }, [forceOpen]);

  function remember() {
    const el = ref.current;
    if (!el) return;
    if (fromCode.current) {
      fromCode.current = false;
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved(), [id]: el.open }));
    } catch {
      // Private window or storage blocked: the page works the same, only nothing is remembered.
    }
  }

  return (
    <details ref={ref} id={id} open={initiallyOpen} onToggle={remember} className="group scroll-mt-4 border-b border-line">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 py-3 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-lg font-semibold">{title}</h2>
          {summary && <span className="text-sm text-muted group-open:hidden">{summary}</span>}
        </span>
        <span aria-hidden="true" className="pt-1 text-lg leading-none">
          <span className="group-open:hidden">+</span>
          <span className="hidden group-open:inline">−</span>
        </span>
      </summary>
      <div className="flex min-w-0 flex-col gap-3 pb-6">{children}</div>
    </details>
  );
}
