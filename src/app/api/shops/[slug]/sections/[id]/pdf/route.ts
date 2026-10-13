import { rateLimit } from "@/lib/apiHttp";
import { createPublicClient } from "@/lib/supabase/public";

/**
 * "Stiahnuť PDF" of a page section (database update 28): redirects to a 10-minute signed
 * address of the cleaned PDF from the shop-files function, which asks the database whether
 * the section is shown and its owner allows the download. Works on the shop's own domain too.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

export async function GET(request: Request, ctx: RouteContext<"/api/shops/[slug]/sections/[id]/pdf">) {
  const { slug, id } = await ctx.params;
  const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
  if (!SLUG.test(slug) || !UUID.test(id)) return notFound();
  const limited = await rateLimit(request, `shop-files:${slug}`);
  if (limited) return limited;
  const supabase = createPublicClient();
  if (!supabase) return notFound();
  const { data, error } = await supabase.functions
    .invoke<{ url?: string }>("shop-files", { body: { action: "section_pdf", slug, section_id: id } })
    .catch(() => ({ data: null, error: true }));
  if (error || typeof data?.url !== "string" || !/^https?:\/\//.test(data.url)) return notFound();
  return new Response(null, {
    status: 302,
    headers: {
      Location: data.url,
      "Cache-Control": "private, max-age=300",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}
