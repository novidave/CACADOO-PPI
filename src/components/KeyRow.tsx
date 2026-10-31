"use client";

import { useId, type ReactNode } from "react";

/**
 * "Mám prístupový kľúč" in the shop page's look (Screen 11, 2026-10-31): a 56 px row button (the orange key in its
 * circle, the text, a chevron that flips) that opens its body with a height transition; `KeyForm` is the key field with
 * the fixed 150 px "Otvoriť" button and the Cacaduu vortex while the key is checked (`@/components/KeyForm`, part of the
 * assistant's own code, not the page's first JavaScript). The row is shared by the assistant's light first view
 * (`ShopAssistant`) and the assistant (`ShopChat`), so nothing moves at the swap. The key is checked only by the shop's
 * system (never by the AI); these files only draw.
 */
export function KeyRow({ label, open, onToggle, children }: { label: string; open: boolean; onToggle: (open: boolean) => void; children: ReactNode }) {
  const body = useId();
  return (
    <div className="ppi-key" data-key-access data-open={open || undefined}>
      <button type="button" className="ppi-key-row" aria-expanded={open} aria-controls={body} onClick={() => onToggle(!open)} data-key-toggle>
        <span className="ppi-key-icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
            <circle cx="8" cy="15" r="4.5" />
            <path d="M11.2 11.8L20 3M16.5 6.5l2.5 2.5M14.3 8.7l1.8 1.8" />
          </svg>
        </span>
        {label}
        <span className="ppi-key-chev" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1A1A1A" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" focusable="false">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      <div id={body} className="ppi-key-body" inert={!open || undefined}>
        <div>
          <div className="px-[13px] pb-[13px]">{children}</div>
        </div>
      </div>
    </div>
  );
}
