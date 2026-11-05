import { getSession } from "@/lib/auth";
import { readMenuDocument } from "@/lib/menuRead";

/** A photo's JPEG (base64, ≤ 1568 px) or a PDF's text: what the owner's browser sends. */
const MAX_IMAGE = 4_000_000;
const MAX_TEXT = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const maxDuration = 120;

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * POST /api/owner/menu/read {shop_id, image?: base64 JPEG, text?: PDF text} — "Nahrať jedálny lístok" on Objednávky
 * jedla → Menu (database update 80). The owner's login; owner_menu_import_hit first (members, 10 a day per shop, the
 * shop's day; counted in owner_ai_usage kind menu), then Claude proposes the rows (@/lib/menuRead) and the tokens go to
 * owner_ai_spend. Answers {rows, left} or {error}: ai_off, import_limit, forbidden, bad_request, failed. Nothing is
 * stored: the owner reviews the rows and saves them with "Uložiť do menu". The menu itself is never logged.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return reply({ error: "forbidden" }, 401);
  let body: { shop_id?: unknown; image?: unknown; text?: unknown };
  try {
    body = await request.json();
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  const shopId = typeof body.shop_id === "string" && UUID.test(body.shop_id) ? body.shop_id : null;
  const image = typeof body.image === "string" && body.image.length <= MAX_IMAGE && /^[A-Za-z0-9+/=]+$/.test(body.image) ? body.image : null;
  const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT).trim() : "";
  if (!shopId || (!image && text.length < 10)) return reply({ error: "bad_request" }, 400);
  if (!process.env.ANTHROPIC_API_KEY) return reply({ error: "ai_off" }, 503);

  const hit = await session.supabase.rpc("owner_menu_import_hit", { p_shop_id: shopId });
  if (hit.error) {
    const code = hit.error.message === "import_limit" ? "import_limit" : hit.error.code === "42501" ? "forbidden" : "failed";
    return reply({ error: code }, code === "import_limit" ? 429 : code === "forbidden" ? 403 : 500);
  }
  try {
    const { rows, usage } = await readMenuDocument(image ? { kind: "image", base64: image } : { kind: "text", text });
    await session.supabase.rpc("owner_ai_spend", { p_shop_id: shopId, p_kind: "menu", p_input: usage.input, p_output: usage.output });
    return reply({ rows, left: Number(hit.data ?? 0) });
  } catch (e) {
    console.error(`menu-read: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    return reply({ error: "failed" }, 502);
  }
}
