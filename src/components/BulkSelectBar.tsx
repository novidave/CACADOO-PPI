"use client";

import { useEffect, useRef, useState } from "react";

const boxesOf = (formId: string) => Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][form="${formId}"]`));

/**
 * The ticks of a list (checkboxes with form={formId}): how many there are, how many are
 * ticked, their values, and "Vybrať všetko".
 */
export function useTicks(formId: string) {
  const [count, setCount] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const update = () => {
      const list = boxesOf(formId);
      setTotal(list.length);
      setCount(list.filter((b) => b.checked).length);
    };
    update();
    document.addEventListener("change", update);
    return () => document.removeEventListener("change", update);
  }, [formId]);

  return {
    count,
    total,
    values: () => boxesOf(formId).filter((b) => b.checked).map((b) => b.value),
    setAll: (on: boolean) => {
      for (const box of boxesOf(formId)) box.checked = on;
      setCount(on ? boxesOf(formId).length : 0);
    },
  };
}

/** "Vybrať všetko": ticked when every row is, half when some are. */
export function SelectAllBox({ ticks, label }: { ticks: ReturnType<typeof useTicks>; label: string }) {
  const all = useRef<HTMLInputElement>(null);
  const { count, total } = ticks;

  useEffect(() => {
    if (all.current) all.current.indeterminate = count > 0 && count < total;
  }, [count, total]);

  return (
    <label className="flex items-center gap-2">
      <input
        ref={all}
        type="checkbox"
        checked={total > 0 && count === total}
        disabled={total === 0}
        className="h-4 w-4 accent-foreground"
        onChange={(event) => ticks.setAll(event.currentTarget.checked)}
        data-bulk-all
      />
      {label}
    </label>
  );
}

/**
 * A bar above a list of ticks (checkboxes with form={formId}): "Vybrať všetko" and a button that
 * sends the ticked rows to that form, after a confirmation. The button stays off until a row is
 * ticked; the rows' own buttons work without it.
 */
export function BulkSelectBar({
  formId,
  labels,
}: {
  formId: string;
  /** delete_selected and confirm contain {n}, the number of ticked rows. */
  labels: { select_all: string; delete_selected: string; confirm: string };
}) {
  const ticks = useTicks(formId);
  const { count } = ticks;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm" data-bulk-bar={formId}>
      <SelectAllBox ticks={ticks} label={labels.select_all} />
      <button
        type="submit"
        form={formId}
        disabled={count === 0}
        onClick={(event) => {
          if (!window.confirm(labels.confirm.replace("{n}", String(count)))) event.preventDefault();
        }}
        className="rounded border border-foreground px-3 py-1 font-medium disabled:border-line disabled:text-muted"
        data-bulk-delete
      >
        {labels.delete_selected.replace("{n}", String(count))}
      </button>
    </div>
  );
}
