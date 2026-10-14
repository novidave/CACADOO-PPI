import { getSession } from "@/lib/auth";

/**
 * "Stiahnuť PDF" for the shop's owners: 10-minute download addresses of finished conversation
 * PDFs from the assistant-archive function, which checks with the owner's own login (RLS) that
 * each conversation belongs to one of their shops. Never for shoppers (they have their own
 * "Stiahnuť túto konverzáciu (PDF)" with the conversation's token).
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PDFS = 50;
export const PRIVATE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };

export interface PdfLinks {
  files: { id: string; url: string; name: string }[];
  missing: string[];
}

/** null: not logged in; "failed": the function refused or failed. */
export async function conversationPdfLinks(ids: string[]): Promise<PdfLinks | null | "failed"> {
  const session = await getSession();
  if (!session) return null;
  const { data, error } = await session.supabase.functions.invoke<Partial<PdfLinks>>("assistant-archive", {
    body: { action: "owner_pdfs", conversation_ids: ids },
  });
  if (error || !data) return "failed";
  const files = (data.files ?? []).filter(
    (f) => UUID.test(f.id) && typeof f.url === "string" && /^https?:\/\//.test(f.url) && typeof f.name === "string",
  );
  return { files, missing: (data.missing ?? []).filter((id) => UUID.test(id)) };
}
