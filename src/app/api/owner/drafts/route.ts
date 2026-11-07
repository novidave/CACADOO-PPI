import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

/**
 * POST /api/owner/drafts — the reply's draft when the page is left (navigator.sendBeacon on `pagehide`, database update
 * 90): {conversation_id, channel, subject, body} with the owner's own login; owner_draft_save decides (members, an empty
 * text clears). Answers 204; nothing else is done or logged.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return new NextResponse(null, { status: 401 });
  const text = await request.text().catch(() => "");
  if (text.length > 12_000) return new NextResponse(null, { status: 413 });
  let body: { conversation_id?: unknown; channel?: unknown; subject?: unknown; body?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const id = String(body.conversation_id ?? "");
  if (!UUID.test(id)) return new NextResponse(null, { status: 400 });
  const { error } = await session.supabase.rpc("owner_draft_save", {
    p_conversation_id: id,
    p_channel: body.channel === "email" ? "email" : "sms",
    p_subject: String(body.subject ?? "").slice(0, 200),
    p_body: String(body.body ?? "").slice(0, 5000),
  });
  return new NextResponse(null, { status: error ? 400 : 204 });
}
