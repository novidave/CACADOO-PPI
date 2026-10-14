"use client";

import { useEffect, useRef, useState } from "react";

const boxesOf = (formId: string) => Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][form="${formId}"]`));

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
  const all = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    if (all.current) all.current.indeterminate = count > 0 && count < total;
  }, [count, total]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm" data-bulk-bar={formId}>
      <label className="flex items-center gap-2">
        <input
          ref={all}
          type="checkbox"
          checked={total > 0 && count === total}
          disabled={total === 0}
          onChange={(event) => {
            const on = event.currentTarget.checked;
            for (const box of boxesOf(formId)) box.checked = on;
            setCount(on ? total : 0);
          }}
          data-bulk-all
        />
        {labels.select_all}
      </label>
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
