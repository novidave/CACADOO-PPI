"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MAX_PHOTO_LIST_BYTES, MAX_PHOTO_ROWS, photoUrlOk, readPhotoFile, type PhotoFile } from "@/lib/productPhotos";

export interface PhotoBulkLabels {
  pick: string;
  pick_help: string;
  reading: string;
  found: string;
  columns: string;
  cut: string;
  start: string;
  starting: string;
  preview_code: string;
  preview_ean: string;
  preview_url: string;
  bad_url_note: string;
  error_empty: string;
  error_no_key: string;
  error_no_url: string;
  error_not_xml: string;
  error_too_big: string;
  error_job_running: string;
  error_job_limit: string;
  error_failed: string;
}

/**
 * "Fotky produktov" → a CSV or XML file (database update 78): read here in the owner's browser (the code — or the EAN —
 * and image_url of each product, the stock importer's XML rule), shown before anything happens; "Nahrať fotky" saves
 * the rows (owner_product_photo_job: the database matches each row to a product) and starts the downloads in the
 * product-photos function, which works in the background — the report below shows each row's result.
 */
export function PhotoBulkUpload({ shopId, labels }: { shopId: string; labels: PhotoBulkLabels }) {
  const router = useRouter();
  const [file, setFile] = useState<{ name: string; read: PhotoFile } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"read" | "start" | null>(null);

  const decode = (bytes: ArrayBuffer) => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      // older exports from shop software in Central Europe
      return new TextDecoder("windows-1250").decode(bytes);
    }
  };

  const pick = async (f: File) => {
    setError(null);
    setFile(null);
    if (f.size > MAX_PHOTO_LIST_BYTES) return setError(labels.error_too_big);
    setBusy("read");
    try {
      const read = readPhotoFile(decode(await f.arrayBuffer()));
      if (typeof read === "string") {
        setError({ empty: labels.error_empty, no_key: labels.error_no_key, no_url: labels.error_no_url, not_xml: labels.error_not_xml }[read]);
        return;
      }
      setFile({ name: f.name, read });
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    if (!file) return;
    setError(null);
    setBusy("start");
    const supabase = createClient();
    const { data, error: failed } = await supabase.rpc("owner_product_photo_job", {
      p_shop_id: shopId,
      p_file_name: file.name.slice(0, 200),
      p_kind: file.read.kind,
      p_rows: file.read.rows,
    });
    if (failed || typeof data !== "string") {
      setBusy(null);
      const m = failed?.message ?? "";
      setError(m.includes("job_running") ? labels.error_job_running : m.includes("job_limit") ? labels.error_job_limit : `${labels.error_failed}${m ? ` (${m.slice(0, 80)})` : ""}`);
      return;
    }
    // the downloads start now; the 5-minute job picks them up too if this call does not arrive
    await supabase.functions.invoke("product-photos", { body: { action: "kick", job_id: data }, method: "POST" }).catch(() => null);
    setFile(null);
    setBusy(null);
    const url = new URL(window.location.href);
    url.searchParams.set("job", data);
    router.replace(`${url.pathname}${url.search}#report`);
    router.refresh();
  };

  const rows = file?.read.rows ?? [];
  const badUrls = rows.filter((r) => r.url && !photoUrlOk(r.url)).length;
  return (
    <div className="flex flex-col gap-3" data-photo-bulk>
      <label className={`inline-flex min-h-12 cursor-pointer items-center justify-center self-start rounded-xl border border-[#D6D6D6] bg-white px-5 text-[15px] font-bold ${busy ? "pointer-events-none opacity-60" : ""}`}>
        <input
          type="file"
          accept=".csv,.xml,.txt,text/csv,text/xml,application/xml"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pick(f);
            e.target.value = "";
          }}
          data-photo-bulk-input
        />
        {busy === "read" ? labels.reading : labels.pick}
      </label>
      <p className="text-sm text-muted">{labels.pick_help.replace("{n}", String(MAX_PHOTO_ROWS))}</p>
      {error && (
        <p role="alert" className="text-sm font-semibold text-[#B91C1C]" data-photo-bulk-error>
          {error}
        </p>
      )}
      {file && (
        <div className="flex flex-col gap-3 rounded-2xl border border-[#E4E4E4] bg-white p-[18px]" data-photo-bulk-preview>
          <p className="font-semibold">{labels.found.replace("{n}", String(rows.length)).replace("{file}", file.name)}</p>
          <p className="text-sm text-muted">
            {labels.columns
              .replace("{code}", file.read.columns.code ?? "–")
              .replace("{ean}", file.read.columns.ean ?? "–")
              .replace("{url}", file.read.columns.url)}
          </p>
          {file.read.cut && <p className="text-sm font-semibold">{labels.cut.replace("{n}", String(MAX_PHOTO_ROWS))}</p>}
          {badUrls > 0 && <p className="text-sm">{labels.bad_url_note.replace("{n}", String(badUrls))}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-muted">
                <tr>
                  <th className="py-1 pr-3 font-medium">{labels.preview_code}</th>
                  <th className="py-1 pr-3 font-medium">{labels.preview_ean}</th>
                  <th className="py-1 font-medium">{labels.preview_url}</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 5).map((r, i) => (
                  <tr key={i} className="border-t border-line align-top">
                    <td className="py-1 pr-3 whitespace-nowrap tabular-nums">{r.code ?? "–"}</td>
                    <td className="py-1 pr-3 whitespace-nowrap tabular-nums">{r.ean ?? "–"}</td>
                    <td className="max-w-[16rem] truncate py-1">{r.url ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={() => void start()}
            disabled={busy !== null}
            className="inline-flex min-h-12 items-center justify-center self-start rounded-xl bg-[#111] px-5 text-[15px] font-bold text-white disabled:opacity-60"
            data-photo-bulk-start
          >
            {busy === "start" ? labels.starting : labels.start.replace("{n}", String(rows.length))}
          </button>
        </div>
      )}
    </div>
  );
}

/** While a file is being worked on, the report is read again every 5 seconds (nothing moves when it is done). */
export function PhotoJobRefresh({ running }: { running: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(id);
  }, [running, router]);
  return null;
}
