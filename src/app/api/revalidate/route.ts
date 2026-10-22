import { timingSafeEqual } from "node:crypto";
import { refreshAll, refreshShop } from "@/lib/publicCache";

/**
 * POST /api/revalidate — the Edge Functions (stock-pull after a new file, shop-blog after a post, page-sections after
 * new pictures, translate after new translations) tell the website that a shop's public pages changed:
 * header `x-ppi-revalidate: <REVALIDATE_SECRET>`, body `{"slug": "…"}` (no slug = every shop). Without it the pages
 * still refresh within 60 s. The secret is server-only (Vercel + Supabase secret), never NEXT_PUBLIC.
 */
export async function POST(request: Request) {
  const secret = process.env.REVALIDATE_SECRET ?? "";
  const given = request.headers.get("x-ppi-revalidate") ?? "";
  const ok = secret.length >= 16 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { slug?: unknown };
  const slug = typeof body.slug === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(body.slug) && body.slug.length <= 80 ? body.slug : null;
  if (body.slug !== undefined && !slug) return Response.json({ error: "slug" }, { status: 400 });
  if (slug) refreshShop(slug);
  else refreshAll();
  return Response.json({ ok: true, slug });
}
