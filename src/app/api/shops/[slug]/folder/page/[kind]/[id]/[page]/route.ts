import { docsToken, verifyPageUrl, viewPage } from "@/lib/docsAccess";
import { watermark, watermarkText } from "@/lib/watermark";

/**
 * One page (or picture) of a private folder for the viewer, with the watermark
 * "<shop name> · VIP · <date>" drawn in. Only with a signed address from this website
 * (10 minutes, bound to this shopper's session) and the session cookie; the database
 * checks the folder again. Served inline, never cached, never indexed.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request, ctx: RouteContext<"/api/shops/[slug]/folder/page/[kind]/[id]/[page]">) {
  const { slug, kind, id, page: pageText } = await ctx.params;
  const page = Number(pageText);
  if ((kind !== "document" && kind !== "picture") || !UUID.test(id) || !Number.isInteger(page) || page < 1 || page > 5000) {
    return notFound();
  }
  const token = await docsToken(slug);
  if (!token || !verifyPageUrl(slug, kind, id, page, token, new URL(request.url).searchParams)) {
    return new Response("Expired", { status: 410, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const source = await viewPage(slug, kind, id, page);
    if (!source) return notFound();
    const response = await fetch(source.url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return notFound();
    const image = await watermark(new Uint8Array(await response.arrayBuffer()), watermarkText(source.shop.name, source.shop.timezone));
    return new Response(new Uint8Array(image), {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Disposition": `inline; filename="${kind === "document" ? `strana-${page}` : "obrazok"}.jpg"`,
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (e) {
    console.error("folder-page:", e instanceof Error ? e.message.slice(0, 120) : "failed");
    return new Response("Not available", { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
