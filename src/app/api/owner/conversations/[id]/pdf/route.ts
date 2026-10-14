import { conversationPdfLinks, PRIVATE, UUID } from "@/lib/conversationPdfs";

/**
 * "Stiahnuť PDF" of one conversation: redirects to its PDF's 10-minute download address (saved
 * by the browser under the PDF's own name, e.g. 2026-10-14_15-30_3f2a9c1b.pdf).
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/owner/conversations/[id]/pdf">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return new Response("Not found", { status: 404, headers: PRIVATE });
  const links = await conversationPdfLinks([id]);
  if (links === null) return new Response("Please log in", { status: 401, headers: PRIVATE });
  const file = links === "failed" ? null : links.files[0];
  if (!file) return new Response("Not found", { status: 404, headers: PRIVATE });
  return new Response(null, { status: 302, headers: { Location: file.url, ...PRIVATE } });
}
