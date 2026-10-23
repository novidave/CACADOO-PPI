/**
 * "Začať sklad odznova" (database update 43): what the danger zone of "Priečinok s exportom" shows and the words for
 * it. Every decision (which products are missing from the last file, whether a removal can be undone, the daily limit)
 * is made in SQL; this file only shapes the answers. Shared with the browser (the dialogs) and the unit tests.
 */

export type ResetKind = "missing" | "all";
export type RestoreBlock = "restored" | "purged" | "expired" | "newer_upload" | "newer_reset";
export type ActivityAction =
  | "stock_files_deleted"
  | "inventory_missing_removed"
  | "inventory_reset"
  | "inventory_restored"
  | "inventory_purged";

/** owner_inventory_preview(): the counts the dialogs show before anything is removed. */
export interface InventoryPreview {
  shop_name: string;
  items: number;
  missing: number;
  missing_list: { code: string; name: string }[];
  files: number;
  resets_left: number;
}

export interface ResetRow {
  id: number;
  kind: ResetKind;
  created_at: string;
  items: number;
  files: number;
  expires_at: string;
  restored_at: string | null;
  keep_translations: boolean;
  cleared_mapping: boolean;
  /** Why "Obnoviť sklad" is not possible any more; null = it is. */
  blocked: RestoreBlock | null;
}

/** owner_inventory_state(): files, removals of the last 30 days, backups, the last actions. */
export interface InventoryState {
  files: number;
  /** The uploaded files were deleted and no file came since ("Žiadny nahraný súbor · nahrajte nový"). */
  files_cleared: boolean;
  files_cleared_at: string | null;
  inventory_reset_at: string | null;
  /** After a full reset, until a new file is applied: "Nahrajte nový skladový súbor". */
  needs_file: boolean;
  items: number;
  resets_left: number;
  resets: ResetRow[];
  backups: { id: number; created_at: string; expires_at: string; file_name: string; rows: number }[];
  activity: { at: string; action: ActivityAction; details: Record<string, unknown> }[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

export function readPreview(data: unknown): InventoryPreview | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  return {
    shop_name: String(d.shop_name ?? ""),
    items: num(d.items),
    missing: num(d.missing),
    missing_list: Array.isArray(d.missing_list)
      ? d.missing_list.map((m) => ({ code: String((m as { code?: unknown }).code ?? ""), name: String((m as { name?: unknown }).name ?? "") }))
      : [],
    files: num(d.files),
    resets_left: num(d.resets_left),
  };
}

export function readState(data: unknown): InventoryState | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const list = <T,>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
  return {
    files: num(d.files),
    files_cleared: d.files_cleared === true,
    files_cleared_at: typeof d.files_cleared_at === "string" ? d.files_cleared_at : null,
    inventory_reset_at: typeof d.inventory_reset_at === "string" ? d.inventory_reset_at : null,
    needs_file: d.needs_file === true,
    items: num(d.items),
    resets_left: num(d.resets_left),
    resets: list<ResetRow>(d.resets),
    backups: list<InventoryState["backups"][number]>(d.backups),
    activity: list<InventoryState["activity"][number]>(d.activity),
  };
}

/** The error codes the SQL functions raise (their message), as the "err" of the page's address. */
const ERRORS = ["confirm_name", "reset_limit", "files_limit", "nothing_to_remove"] as const;

export function resetError(message: string): string {
  if ((ERRORS as readonly string[]).includes(message)) return `reset_${message}`;
  const restore = /^restore_(restored|purged|expired|newer_upload|newer_reset)$/.exec(message);
  if (restore) return `reset_blocked_${restore[1]}`;
  return message;
}

/** The text of a "reset_…" error code (null: not one of them). */
export function resetErrorText(labels: Record<string, string>, err: string): string | null {
  if (!err.startsWith("reset_")) return null;
  const code = err.slice("reset_".length);
  if (code.startsWith("storage:")) return labels.err_storage.replace("{message}", code.slice("storage:".length));
  if (code.startsWith("blocked_")) return labels[code] ?? null;
  return labels[`err_${code}`] ?? null;
}

/** The download address of a backup (its owner only; the route asks the database). */
export function backupHref(id: number): string {
  return `/api/owner/inventory-backups/${id}`;
}

/** The shop's name typed to confirm a full reset: the same rule as the database (case and outer spaces ignored). */
export function nameMatches(typed: string, shopName: string): boolean {
  return typed.trim().toLowerCase() === shopName.trim().toLowerCase() && shopName.trim() !== "";
}
