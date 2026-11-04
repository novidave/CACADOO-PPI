import { NextResponse, type NextRequest } from "next/server";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { getSession } from "@/lib/auth";
import { assistantRefusal } from "@/lib/ownerAssistant";
import { refreshShop } from "@/lib/publicCache";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * "Potvrdiť" / "Zrušiť" on the AI pomocník's card (database update 76): assistant_confirm runs the waiting write through
 * the one door — the same owner, within 10 minutes, once (activity marked source 'web') — then the shop's public pages
 * are refreshed when something changed.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return json({ error: "login" }, 401);
  const body = (await request.json().catch(() => null)) as { id?: unknown; action?: unknown; lang?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!UUID.test(id)) return json({ error: "not_found" }, 400);
  const lang = typeof body?.lang === "string" && isLocale(body.lang) ? body.lang : "sk";
  if (body?.action === "cancel") {
    await session.supabase.rpc("assistant_cancel", { p_id: id });
    return json({ ok: true, cancelled: true });
  }
  const { data, error } = await session.supabase.rpc("assistant_confirm", { p_id: id });
  if (error) {
    const reason = error.message.split(":")[0].trim();
    if (reason === "expired" || reason === "used" || reason === "not_found") return json({ error: reason });
    return json({ error: "change", reason: assistantRefusal(await getDictionary(lang), error.message) });
  }
  const out = (data as { out?: { shop?: string; changed?: boolean } } | null)?.out;
  if (out?.changed !== false) refreshShop(out?.shop ?? null);
  return json({ ok: true });
}
