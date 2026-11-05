"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass, ghostClass } from "./ui";

/** Whether one form field differs from what the page drew. A field without a name is never sent (e.g. a list's search
 * box, 2026-11-05), so it never counts. */
function changed(el: Element): boolean {
  if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && !el.name) return false;
  if (el instanceof HTMLInputElement) {
    if (el.type === "hidden" || el.type === "submit" || el.type === "button") return false;
    if (el.type === "checkbox" || el.type === "radio") return el.checked !== el.defaultChecked;
    return el.value !== el.defaultValue;
  }
  if (el instanceof HTMLTextAreaElement) return el.value !== el.defaultValue;
  if (el instanceof HTMLSelectElement) return [...el.options].some((o) => o.selected !== o.defaultSelected);
  return false;
}

/**
 * The owner pages' save bar (back-end layout L3, canvas artboard 9): it sticks to the bottom of the screen inside its
 * form — "Neuložené zmeny: n" · Zrušiť (the form as drawn again) · Uložiť (≥ 180 px, the form's own submit). Without
 * JavaScript it is a plain "Uložiť" button. The count is only a help; the server action decides what is saved.
 */
export function SaveBar({ labels }: { labels: { unsaved: string; cancel: string; save: string; saving: string } }) {
  const bar = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const { pending } = useFormStatus();

  useEffect(() => {
    const form = bar.current?.closest("form");
    if (!form) return;
    // a radio group counts once
    const recount = () => {
      const names = new Set<string>();
      for (const el of Array.from(form.elements)) {
        if (!changed(el)) continue;
        names.add((el as HTMLInputElement).name || String(names.size));
      }
      setCount(names.size);
    };
    const afterReset = () => requestAnimationFrame(recount);
    form.addEventListener("input", recount);
    form.addEventListener("change", recount);
    form.addEventListener("reset", afterReset);
    return () => {
      form.removeEventListener("input", recount);
      form.removeEventListener("change", recount);
      form.removeEventListener("reset", afterReset);
    };
  }, []);

  return (
    <div
      ref={bar}
      className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#E4E4E4] bg-white px-4 py-3 md:mx-0 md:px-0"
      data-save-bar
    >
      <span className="text-[15px] font-semibold" aria-live="polite" data-unsaved={count}>
        {count > 0 ? labels.unsaved.replace("{n}", String(count)) : ""}
      </span>
      <div className="flex gap-2.5">
        <button type="reset" className={ghostClass} disabled={count === 0 || pending}>
          {labels.cancel}
        </button>
        <button type="submit" className={`${buttonClass} min-w-[180px]`} disabled={pending} aria-busy={pending}>
          {pending ? labels.saving : labels.save}
        </button>
      </div>
    </div>
  );
}
