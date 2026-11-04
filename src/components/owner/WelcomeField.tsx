"use client";

import { useRef } from "react";
import { LIST_TOKEN } from "@/lib/chatList";
import { insertIntoField } from "./MessageTools";
import { Field } from "./ui";

/**
 * The assistant's welcome text in Asistent → texty (2026-11-04): the plain textarea of `owner_set_assistant_texts` plus
 * the {zoznam} tag — a click (or Enter) puts it at the cursor, a drag drops it where it is let go (the browser's own
 * drop into the field). Stored as the plain token; plain_text() and every translation keep it; on the shop page it is
 * the live bubble of the shopper's shopping list.
 */
export function WelcomeField({
  label,
  defaultValue,
  placeholder,
  className,
  insertLabel,
  hint,
}: {
  label: string;
  defaultValue: string;
  placeholder: string;
  className: string;
  insertLabel: string;
  hint: string;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="flex flex-col gap-2">
      <Field label={label}>
        <textarea ref={field} name="assistant_welcome" maxLength={300} rows={3} defaultValue={defaultValue} placeholder={placeholder} className={className} data-welcome-field />
      </Field>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          draggable
          title={insertLabel}
          aria-label={insertLabel}
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", LIST_TOKEN);
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={() => field.current && insertIntoField(field.current, LIST_TOKEN)}
          className="inline-flex min-h-11 cursor-grab touch-manipulation select-none items-center gap-2 rounded-full border border-[#111] bg-white px-3 font-mono text-sm font-semibold text-[#111] hover:bg-[#F4F4F4] active:cursor-grabbing [-webkit-touch-callout:none]"
          data-list-token
        >
          <span className="inline-block h-3.5 w-3.5 rounded-full bg-[#2563EB]" aria-hidden="true" />
          {LIST_TOKEN}
        </button>
        <span className="text-sm text-muted">{hint}</span>
      </div>
    </div>
  );
}
