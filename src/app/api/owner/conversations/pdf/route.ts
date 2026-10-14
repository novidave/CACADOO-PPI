import { conversationPdfLinks, MAX_PDFS, PRIVATE, UUID } from "@/lib/conversationPdfs";

/**
 * "Stiahnuť vybrané" in Konverzácie asistenta: POST {ids} (the ticked conversations, at most
 * 50) → {files: [{id, url, name}], missing: [ids]}; the browser then downloads each file.
 */
export async function POST(request: Request) {
  let ids: unknown;
  try {
    ids = ((await request.json()) as { ids?: unknown }).ids;
  } catch {
    ids = null;
  }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_PDFS || !ids.every((id) => typeof id === "string" && UUID.test(id))) {
    return Response.json({ error: "bad_request" }, { status: 400, headers: PRIVATE });
  }
  const links = await conversationPdfLinks([...new Set(ids as string[])]);
  if (links === null) return Response.json({ error: "login" }, { status: 401, headers: PRIVATE });
  if (links === "failed") return Response.json({ error: "failed" }, { status: 502, headers: PRIVATE });
  return Response.json(links, { headers: PRIVATE });
}
