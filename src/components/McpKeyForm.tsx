"use client";

import { useActionState, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import type { McpKeyState } from "@/app/[lang]/(account)/dashboard/ai/actions";

/** "Kľúč pre AI asistenta" (database update 61): shown here once with Copy; only its hash is kept. */
export function McpKeyForm({
  action,
  shops,
  labels,
}: {
  action: (previous: McpKeyState, formData: FormData) => Promise<McpKeyState>;
  shops: { id: string; name: string }[];
  labels: Dictionary["owner_mcp"];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [copied, setCopied] = useState<string | null>(null);
  const texts = labels as Record<string, string>;
  const inputClass = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
  const scopes: [string, string][] = [
    ["shop.write", labels.scope_write],
    ["messages.send", labels.scope_messages],
  ];

  return (
    <div className="flex min-w-0 flex-col gap-3" data-mcp-key>
      {state.key && (
        <div className="flex flex-col gap-2 border border-foreground p-3" role="status">
          <span className="text-sm">{labels.key_once.replace("{name}", state.name ?? "")}</span>
          <code className="select-all break-all font-mono text-sm font-semibold">{state.key}</code>
          <button
            type="button"
            className="min-h-11 self-start rounded border border-line px-3 text-sm"
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
      )}
      {state.error && <p className="border border-line p-3 text-sm">{texts[state.error] ?? labels.key_failed}</p>}
      <form action={formAction} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm">{labels.key_name}</span>
          <input name="name" required maxLength={100} placeholder={labels.key_name_example} className={`${inputClass} text-base`} />
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm">{labels.consent_shops}</legend>
          {shops.map((s) => (
            <label key={s.id} className="flex min-h-11 items-center gap-2">
              <input type="checkbox" name="shop" value={s.id} defaultChecked className="h-4 w-4 accent-foreground" />
              {s.name}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm">{labels.consent_scopes}</legend>
          <label className="flex min-h-11 items-start gap-2 py-1 text-sm text-muted">
            <input type="checkbox" checked disabled readOnly className="mt-1 h-4 w-4 accent-foreground" />
            {labels.scope_read}
          </label>
          {scopes.map(([s, text]) => (
            <label key={s} className="flex min-h-11 items-start gap-2 py-1 text-sm">
              <input type="checkbox" name={`scope_${s}`} className="mt-1 h-4 w-4 accent-foreground" />
              {text}
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={pending} className="min-h-11 self-start rounded border border-foreground px-4 py-2 font-medium">
          {pending ? labels.creating : labels.key_create}
        </button>
      </form>
    </div>
  );
}
