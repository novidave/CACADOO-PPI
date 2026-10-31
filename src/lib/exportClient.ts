import { createClient } from "./supabase/client";
import { buildWorkbook, fileName, langColumns, mainColumns, readEdits, type ExportFileLabels, type ExportInfo, type ExportRow, type FileEdits } from "./exportFiles";
import { zip } from "./xlsx";

/**
 * The translation files of update 45 as the owner's browser makes and reads them — one code for "Preklady v
 * priečinku" (the folder, "Stiahnuť preklady (.xlsx, ZIP)", "Nahrať upravený súbor") and Tovar's shortcuts (update
 * 62, the same files narrowed to the products of a filter or the ticked ones). Rows come only from
 * owner_export_rows() (the approved columns; private columns are never stored by PPI).
 */

const PAGE = 1000;

/** Every row of one file (lang null = the main file). */
export async function exportRows(shopId: string, lang: string | null): Promise<ExportRow[]> {
  const supabase = createClient();
  const all: ExportRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.rpc("owner_export_rows", { p_shop_id: shopId, p_lang: lang, p_offset: offset, p_limit: PAGE });
    if (error) throw new Error(error.message);
    const page = (data ?? []) as ExportRow[];
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

export async function exportInfo(shopId: string): Promise<ExportInfo> {
  const { data, error } = await createClient().rpc("owner_export_info", { p_shop_id: shopId });
  if (error) throw new Error(error.message);
  return data as ExportInfo;
}

/** The bytes of one file (lang null = the main file); `only` = just these products. */
export async function workbookFor(
  shopId: string,
  info: ExportInfo,
  lang: string | null,
  labels: ExportFileLabels,
  pageLang: string,
  only: ReadonlySet<string> | null = null,
) {
  const all = await exportRows(shopId, lang);
  const rows = only ? all.filter((r) => only.has(r.item_id)) : all;
  const columns = lang ? langColumns(labels) : mainColumns(info, labels, pageLang);
  const bytes = await buildWorkbook({ shopId, lang, mainLang: info.main_lang, columns, rows, labels, writtenAt: new Date().toISOString() });
  return { bytes, rows: rows.length };
}

/** The files of these languages (null = the main file) in one ZIP, saved by the browser. Returns how many files. */
export async function downloadZip(input: {
  shopId: string;
  info: ExportInfo;
  langs: (string | null)[];
  /** the files' texts; zip_name names the ZIP */
  labels: ExportFileLabels & Record<string, string>;
  pageLang: string;
  name: string;
  only?: ReadonlySet<string> | null;
}): Promise<number> {
  const entries: { name: string; data: Uint8Array }[] = [];
  for (const l of input.langs) {
    const file = await workbookFor(input.shopId, input.info, l, input.labels, input.pageLang, input.only ?? null);
    entries.push({ name: fileName(l ?? input.info.main_lang), data: file.bytes });
  }
  const blob = new Blob([(await zip(entries)) as BlobPart], { type: "application/zip" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${input.labels.zip_name ?? "cacaduu"}-${input.name}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return entries.length;
}

/** The owner's edits of one file Cacaduu wrote, or why it cannot be read: not_ours | other_shop | failed. */
export async function fileEdits(bytes: Uint8Array, shopId: string): Promise<{ ok: true; edits: FileEdits } | { ok: false; error: "not_ours" | "other_shop" | "failed"; detail: string }> {
  let edits: FileEdits;
  try {
    edits = await readEdits(bytes);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: ["not_ours", "not_xlsx", "no_code_column"].includes(detail) ? "not_ours" : "failed", detail };
  }
  if (edits.shopId !== shopId) return { ok: false, error: "other_shop", detail: "" };
  return { ok: true, edits };
}
