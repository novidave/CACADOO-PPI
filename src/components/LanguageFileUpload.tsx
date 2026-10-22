"use client";

import { useRef, useState } from "react";
import { compress } from "@/lib/folderStore";
import { createClient } from "@/lib/supabase/client";
import { supabaseEnv } from "@/lib/supabase/env";

export interface LanguageFileLabels {
  target: string;
  target_main: string;
  choose: string;
  encoding: string;
  encoding_auto: string;
  detected: string;
  preview_title: string;
  preview_rows: string;
  upload: string;
  uploading: string;
  cancel: string;
  matched: string;
  unmatched: string;
  unmatched_more: string;
  conflicts: string;
  conflict_row: string;
  main_done: string;
  failed: string;
  help: string;
}

const ENCODINGS = ["utf-8", "utf-16le", "utf-16be", "windows-1250", "windows-1252", "windows-1258", "gb18030", "big5"] as const;

interface Preview {
  encoding: string;
  detected: string;
  rows: number;
  sample: Record<string, string>[];
}

interface LanguageResult {
  status: "translations";
  matched: number;
  unmatched_count: number;
  unmatched: { source_code: string | null; ean: string | null; name: string | null }[];
  conflicts: { source_code: string; name: string; quantity: number | null; main_quantity: number | null; price: number | null; main_price: number | null }[];
}

type Result = LanguageResult | { status: "updated"; items: number; zeroed: number } | { status: "error"; error: string } | { status: string };

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? `{${k}}`));

/**
 * A stock file with a preview (update 40): the owner picks the file and whether it is the main stock file or the
 * shop's file in another language; the file is first only read (its encoding — UTF-8, Windows-1250, Windows-1258,
 * GB18030 … — detected and changeable, the first rows of the columns that will be read), then sent. A file in another
 * language is matched by Kód, then EAN: "Spárované / Nespárované / Rozdiely" (its quantities and prices are never
 * used). Nothing private is shown: only the columns that will be read.
 */
export function LanguageFileUpload({
  shopId,
  langs,
  mainLabel,
  labels,
}: {
  shopId: string;
  /** The shop's other inventory languages (a second file is in one of them). */
  langs: { code: string; native: string }[];
  mainLabel: string;
  labels: LanguageFileLabels;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState<string>("main");
  const [encoding, setEncoding] = useState<string>("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (chosen: File, query: Record<string, string>) => {
    const env = supabaseEnv();
    if (!env) throw new Error("Supabase is not configured");
    const { data } = await createClient().auth.getSession();
    if (!data.session) throw new Error("login");
    const { body, gzip } = await compress(await chosen.arrayBuffer());
    const params = new URLSearchParams({ shop_id: shopId, ...query, ...(gzip ? { gzip: "1" } : {}) });
    const response = await fetch(`${env.url}/functions/v1/stock-pull?${params}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${data.session.access_token}`, apikey: env.key, "Content-Type": "application/octet-stream" },
      body,
    });
    const json = (await response.json().catch(() => null)) as { preview?: Preview; result?: Result; error?: string } | null;
    if (!response.ok || !json) throw new Error(json?.error ?? `HTTP ${response.status}`);
    return json;
  };

  const look = async (chosen: File, enc: string) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const json = await send(chosen, { preview: "1", ...(enc ? { encoding: enc } : {}) });
      setPreview(json.preview ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const enc = encoding || preview?.encoding || "";
      const query: Record<string, string> =
        target === "main"
          ? { file_time: new Date(file.lastModified).toISOString(), file_name: file.name }
          : { translation_lang: target };
      const json = await send(file, { ...query, ...(enc ? { encoding: enc } : {}) });
      setResult(json.result ?? null);
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const columns = preview?.sample[0] ? Object.keys(preview.sample[0]) : [];
  return (
    <div className="flex flex-col gap-3" data-language-file>
      <p className="text-sm text-muted">{labels.help}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{labels.target}</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="rounded border border-line px-2 py-2" data-file-target>
            <option value="main">{fill(labels.target_main, { lang: mainLabel })}</option>
            {langs.map((l) => (
              <option key={l.code} value={l.code}>
                {l.native}
              </option>
            ))}
          </select>
        </label>
        <input
          ref={input}
          type="file"
          accept=".csv,.txt,.xml,.xlsx,text/csv,application/xml,text/xml,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          tabIndex={-1}
          data-file-input
          onChange={(e) => {
            const chosen = e.currentTarget.files?.[0] ?? null;
            e.currentTarget.value = "";
            setFile(chosen);
            setEncoding("");
            if (chosen) look(chosen, "");
          }}
        />
        <button type="button" onClick={() => input.current?.click()} disabled={busy} className="rounded border border-foreground px-4 py-2 font-medium">
          {labels.choose}
        </button>
        {file && <span className="text-sm">{file.name}</span>}
      </div>

      {preview && file && (
        <div className="flex flex-col gap-2 border border-line p-3" data-file-preview>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-muted">{labels.encoding}</span>
              <select
                value={encoding}
                onChange={(e) => {
                  setEncoding(e.target.value);
                  look(file, e.target.value);
                }}
                className="rounded border border-line px-2 py-2"
                data-file-encoding
              >
                <option value="">{fill(labels.encoding_auto, { encoding: preview.detected })}</option>
                {ENCODINGS.map((enc) => (
                  <option key={enc} value={enc}>
                    {enc}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-muted" data-file-detected={preview.detected}>
              {fill(labels.detected, { encoding: preview.encoding, rows: preview.rows })}
            </span>
          </div>
          <p className="text-sm font-semibold">{labels.preview_title}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line text-left">
                  {columns.map((c) => (
                    <th key={c} className="py-1 pr-3 font-semibold">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((row, i) => (
                  <tr key={i} className="border-b border-line">
                    {columns.map((c) => (
                      <td key={c} className="py-1 pr-3">
                        {row[c]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={upload} disabled={busy} className="rounded border border-foreground px-4 py-2 font-medium" data-file-upload>
              {busy ? labels.uploading : labels.upload}
            </button>
            <button type="button" onClick={() => (setPreview(null), setFile(null))} className="underline underline-offset-4">
              {labels.cancel}
            </button>
          </div>
        </div>
      )}

      {result && <ResultBox result={result} labels={labels} />}
      {error && (
        <p role="alert" className="border border-line p-3 text-sm">
          {fill(labels.failed, { error })}
        </p>
      )}
    </div>
  );
}

function ResultBox({ result, labels }: { result: Result; labels: LanguageFileLabels }) {
  if (result.status === "error") {
    return (
      <p role="alert" className="border border-line p-3 text-sm">
        {fill(labels.failed, { error: (result as { error: string }).error })}
      </p>
    );
  }
  if (result.status !== "translations") {
    const r = result as { items?: number; zeroed?: number };
    return (
      <p role="status" className="border border-foreground p-3 text-sm" data-file-result="main">
        {fill(labels.main_done, { status: result.status, items: r.items ?? 0 })}
      </p>
    );
  }
  const r = result as LanguageResult;
  return (
    <div role="status" className="flex flex-col gap-2 border border-foreground p-3 text-sm" data-file-result="translations">
      <p className="font-semibold" data-file-matched={r.matched}>
        {fill(labels.matched, { n: r.matched })}
      </p>
      {r.unmatched_count > 0 && (
        <details>
          <summary className="cursor-pointer" data-file-unmatched={r.unmatched_count}>
            {fill(labels.unmatched, { n: r.unmatched_count })}
          </summary>
          <ul className="mt-1 list-disc pl-5">
            {r.unmatched.map((u, i) => (
              <li key={i}>{[u.source_code, u.ean, u.name].filter(Boolean).join(" · ")}</li>
            ))}
          </ul>
          {r.unmatched_count > r.unmatched.length && <p className="text-muted">{fill(labels.unmatched_more, { n: r.unmatched_count - r.unmatched.length })}</p>}
        </details>
      )}
      {r.conflicts.length > 0 && (
        <details>
          <summary className="cursor-pointer" data-file-conflicts={r.conflicts.length}>
            {fill(labels.conflicts, { n: r.conflicts.length })}
          </summary>
          <ul className="mt-1 list-disc pl-5">
            {r.conflicts.map((c, i) => (
              <li key={i}>
                {fill(labels.conflict_row, {
                  item: `${c.source_code} ${c.name}`,
                  quantity: c.quantity ?? "–",
                  main_quantity: c.main_quantity ?? "–",
                  price: c.price ?? "–",
                  main_price: c.main_price ?? "–",
                })}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
