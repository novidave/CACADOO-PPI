import { blogRssResponse } from "@/lib/blogFeed";

/** The shop's RSS feed on its own domain: src/proxy.ts sends "/blog/rss.xml" of that domain here (only while live). */
export async function GET(_request: Request, ctx: RouteContext<"/api/site/[slug]/blog-rss">) {
  const { slug } = await ctx.params;
  return await blogRssResponse(slug, true);
}
