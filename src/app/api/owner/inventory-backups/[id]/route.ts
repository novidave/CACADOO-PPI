import { getSession } from "@/lib/auth";
import { PRIVATE } from "@/lib/conversationPdfs";

/**
 * "Stiahnuť CSV" of a stock backup ("Zálohy", database update 43): only the shop's owners get it — the database
 * checks it (owner_inventory_backup) — saved by the browser under its own name, e.g. davide-zaloha-skladu-….csv.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/owner/inventory-backups/[id]">) {
  const { id } = await ctx.params;
  const backupId = Number(id);
  if (!/^\d{1,18}$/.test(id) || !Number.isSafeInteger(backupId)) return new Response("Not found", { status: 404, headers: PRIVATE });
  const session = await getSession();
  if (!session) return new Response("Please log in", { status: 401, headers: PRIVATE });
  const { data, error } = await session.supabase.rpc("owner_inventory_backup", { p_backup_id: backupId });
  const row = (Array.isArray(data) ? data[0] : null) as { file_name?: string; csv?: string } | null;
  if (error || !row?.csv) return new Response("Not found", { status: 404, headers: PRIVATE });
  const name = (row.file_name ?? "zaloha-skladu.csv").replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(row.csv, {
    headers: {
      ...PRIVATE,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}
