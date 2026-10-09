"use client";

import { useActionState, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import type { KeyState } from "@/app/[lang]/(account)/dashboard/docActions";
import type { FolderOption } from "./DocUpload";

type Labels = Dictionary["docs"];

/** "New access key": the key is shown here once, with Copy; only its hash is kept. */
export function FolderKeyForm({
  action,
  shopId,
  timeZone,
  folders,
  labels,
}: {
  action: (previous: KeyState, formData: FormData) => Promise<KeyState>;
  shopId: string;
  timeZone: string;
  folders: FolderOption[];
  labels: Labels;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [copied, setCopied] = useState<string | null>(null);
  const errors = labels as Record<string, string>;
  const inputClass = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";

  return (
    <div className="flex min-w-0 flex-col gap-3 border border-line p-3">
      <span className="font-medium">{labels.key_new}</span>
      {state.key ? (
        <div className="flex flex-col gap-2 border border-foreground p-3" role="status">
          <span className="text-sm">{labels.key_once.replace("{label}", state.label ?? "")}</span>
          <code className="select-all break-all text-lg font-semibold tracking-wider">{state.key}</code>
          <button
            type="button"
            className="self-start rounded border border-line px-3 py-1 text-sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(state.key!);
                setCopied(state.key!);
              } catch {
                setCopied("");
              }
            }}
          >
            {copied === state.key ? labels.copied : copied === "" ? labels.copy_failed : labels.copy}
          </button>
        </div>
      ) : null}
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="shop_id" value={shopId} />
        <input type="hidden" name="timezone" value={timeZone} />
        <label className="flex flex-col gap-1">
          <span className="text-sm">{labels.key_label}</span>
          <input name="label" required maxLength={80} placeholder={labels.key_label_example} className={inputClass} />
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm">{labels.key_folders}</legend>
          {folders.map((f) => (
            <label key={f.id} className="flex items-center gap-2">
              <input type="checkbox" name="folders" value={f.id} />
              {f.name}
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1">
          <span className="text-sm">{labels.key_expires}</span>
          <input type="date" name="expires" className={`${inputClass} w-48`} />
        </label>
        {state.error && <p className="border border-line p-3 text-sm">{errors[`error_${state.error}`] ?? state.error}</p>}
        <button type="submit" disabled={pending} className="self-start rounded border border-foreground px-4 py-2 font-medium disabled:text-muted">
          {pending ? labels.saving : labels.key_create}
        </button>
      </form>
    </div>
  );
}
