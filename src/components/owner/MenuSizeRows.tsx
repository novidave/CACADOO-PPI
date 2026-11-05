"use client";

import { useState } from "react";
import { fieldClass, ghostClass } from "./ui";

/**
 * The dish form's sizes (update 80): label + price per size (32 cm · 7,50), "Pridať veľkosť", "Odstrániť veľkosť"; an
 * existing size keeps its id (its Sklad product). Without JavaScript the form shows the existing sizes and two empty
 * rows. A size removed here is hidden by SQL, never deleted.
 */
export function MenuSizeRows({
  initial,
  labels,
}: {
  initial: { id: string | null; label: string; price: string }[];
  labels: { size: string; price: string; add: string; remove: string };
}) {
  let next = 0;
  const [rows, setRows] = useState(() => initial.map((r) => ({ ...r, key: `s${next++}` })));
  const [seq, setSeq] = useState(initial.length);
  return (
    <div className="flex flex-col gap-2" data-menu-sizes>
      {rows.map((row, i) => (
        <div key={row.key} className="flex items-end gap-2" data-size-row>
          <input type="hidden" name="size_id" value={row.id ?? ""} />
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-semibold">
            {labels.size}
            <input name="size_label" defaultValue={row.label} maxLength={40} className={fieldClass} />
          </label>
          <label className="flex w-32 flex-col gap-1 text-sm font-semibold">
            {labels.price}
            <input name="size_price" defaultValue={row.price} inputMode="decimal" maxLength={12} className={fieldClass} />
          </label>
          <button
            type="button"
            className="flex h-[52px] w-11 flex-none items-center justify-center rounded-lg border border-[#E4E4E4]"
            aria-label={`${labels.remove} ${i + 1}`}
            onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className={`${ghostClass} self-start`}
        onClick={() => {
          setRows([...rows, { id: null, label: "", price: "", key: `s${seq}` }]);
          setSeq(seq + 1);
        }}
        data-size-add
      >
        + {labels.add}
      </button>
    </div>
  );
}
