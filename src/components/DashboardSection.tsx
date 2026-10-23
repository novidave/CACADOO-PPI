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
 * Runs while the page is still being read, before anything is shown (performance pass): the same choice as the effect
 * below, so a section never opens after the first paint and nothing jumps (desktop CLS was 0.23). The state it set is
 * kept in data-auto, so the browser's toggle event for it is not taken as the owner's choice.
 */
function openScript(id: string, first: boolean, forceOpen: boolean, collapsed: boolean) {
  const args = [id, STORAGE_KEY, PHONE, first, forceOpen, collapsed].map((v) => JSON.stringify(v)).join(",");
  const code = `(function(i,k,p,f,o,z){var d=document.getElementById(i);if(!d)return;var c;try{c=JSON.parse(localStorage.getItem(k)||"{}")[i]}catch(e){}var w=o||location.hash==="#"+i||(typeof c==="boolean"?c:f||(!z&&!matchMedia(p).matches));if(d.open!==w){d.dataset.auto=String(w);d.open=w}})(${args})`;
  return code.replace(/</g, "\\u003c");
}

/**
 * One main section of Môj obchod as a dropdown: heading plus a short summary line while
 * closed. On a phone only the first section starts open, on a computer all of them; what
 * the owner opens or closes is remembered on this device. The section a form was sent from
 * (?at=… / #…) always opens, so its message is seen. A `collapsed` section (a danger zone) starts closed everywhere.
 */
export function DashboardSection({
  id,
  title,
  summary,
  first = false,
  forceOpen = false,
  collapsed = false,
  children,
}: {
  id: string;
  title: string;
  summary?: string | null;
  first?: boolean;
  forceOpen?: boolean;
  /** Closed on every device until the owner opens it (not only on phones). */
  collapsed?: boolean;
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
      (typeof choice === "boolean" ? choice : first || (!collapsed && !window.matchMedia(PHONE).matches));
    setFromCode(ref.current, wanted, fromCode);
  }, [id, first, collapsed]);

  // A form of this section was just sent: open it so its message is seen.
  useEffect(() => {
    if (forceOpen) setFromCode(ref.current, true, fromCode);
  }, [forceOpen]);

  function remember() {
    const el = ref.current;
    if (!el) return;
    // The toggle of the first-paint script (openScript), not the owner's.
    if (el.dataset.auto !== undefined) {
      const auto = el.dataset.auto === String(el.open);
      delete el.dataset.auto;
      if (auto) return;
    }
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
    <>
      <details
        ref={ref}
        id={id}
        open={initiallyOpen}
        onToggle={remember}
        suppressHydrationWarning
        className="group scroll-mt-4 border-b border-line"
      >
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
      <script dangerouslySetInnerHTML={{ __html: openScript(id, first, forceOpen, collapsed) }} suppressHydrationWarning />
    </>
  );
}
