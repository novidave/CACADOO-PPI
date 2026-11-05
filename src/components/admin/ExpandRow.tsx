"use client";

import { useState, type ReactNode } from "react";

/**
 * One row of a table that opens in place (Admin → Obchody a domény, 2026-11-05): the row's cells, then "Otvoriť" /
 * "Zavrieť" (a real button with aria-expanded / aria-controls); the panel under the row while open. The cells and the
 * panel are drawn on the server (the panel's forms are server actions).
 */
export function ExpandRow({
  id,
  cells,
  panel,
  label,
  openLabel,
  closeLabel,
  startOpen = false,
  className,
  ...data
}: {
  id: string;
  cells: ReactNode;
  panel: ReactNode;
  label: string;
  openLabel: string;
  closeLabel: string;
  startOpen?: boolean;
  className: string;
} & Record<`data-${string}`, string | undefined>) {
  const [open, setOpen] = useState(startOpen);
  return (
    <div {...data} data-open={open ? "" : undefined}>
      <div className={className}>
        {cells}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-xl border px-3.5 text-[15px] font-bold ${open ? "border-[#111] bg-[#111] text-white" : "border-[#D6D6D6] bg-white text-[#111]"}`}
          data-row-toggle
        >
          {open ? closeLabel : openLabel}
        </button>
      </div>
      <section id={id} aria-label={label} hidden={!open} className="mb-2.5 flex flex-col gap-3.5 rounded-[14px] bg-[#F4F4F4] p-4" data-row-panel>
        {panel}
      </section>
    </div>
  );
}
