"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { setStockSource, type StockSource } from "@/app/[lang]/(account)/sync/connectorActions";
import type { Dictionary } from "@/i18n/dictionaries";

type Labels = Dictionary["stock_source"];

const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? values[key] : all));

/**
 * "Zdroj zásob" (database update 52): one stock source at a time — files (the PPI window's folder or a manual upload)
 * or the POS agent. A connected inventory program (update 49) wins and is only named here: it is disconnected in its
 * own section. The database decides (owner_set_stock_source); the page reloads so the locks follow at once.
 */
export function StockSourcePanel({
  shopId,
  initial,
  programName,
  labels,
}: {
  shopId: string;
  initial: StockSource;
  programName: string | null;
  labels: Labels;
}) {
  const router = useRouter();
  const [source, setSource] = useState(initial);
  const [choice, setChoice] = useState<"file" | "agent">(initial.active === "agent" ? "agent" : "file");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const l = labels as Record<string, string>;

  if (source.active === "api") {
    return (
      <div className="flex flex-col gap-2 text-sm" data-stock-source="api">
        <p>{labels.intro}</p>
        <p className="font-semibold">{fill(labels.api_active, { program: programName ?? source.api_provider ?? "" })}</p>
      </div>
    );
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await setStockSource(shopId, choice);
      if (result.ok) {
        setSource(result.value);
        setMessage(labels.saved);
        router.refresh();
      } else {
        setMessage(l[`error_${result.error}`] ?? labels.error_failed);
      }
    } finally {
      setBusy(false);
    }
  }

  const option = (value: "file" | "agent", title: string, hint: string, disabled = false) => (
    <label className={`flex gap-3 border p-3 ${choice === value ? "border-foreground" : "border-line"} ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      <input
        type="radio"
        name="stock_source"
        value={value}
        checked={choice === value}
        disabled={disabled || busy}
        onChange={() => setChoice(value)}
        className="mt-1"
      />
      <span className="flex flex-col gap-1">
        <span className="font-medium">{title}</span>
        <span className="text-sm text-muted">{hint}</span>
      </span>
    </label>
  );

  return (
    <div className="flex flex-col gap-3" data-stock-source={source.active}>
      <p className="text-sm">{labels.intro}</p>
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{labels.title}</legend>
        {option("file", labels.file, labels.file_hint)}
        {option("agent", labels.agent, source.devices > 0 ? labels.agent_hint : labels.agent_no_device, source.devices === 0)}
      </fieldset>
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy || choice === source.active}
        className="self-start border border-foreground px-4 py-2 font-medium disabled:opacity-50"
        data-save-source
      >
        {busy ? labels.saving : labels.save}
      </button>
      {message && (
        <p className="text-sm font-semibold" role="status" data-source-message>
          {message}
        </p>
      )}
    </div>
  );
}
