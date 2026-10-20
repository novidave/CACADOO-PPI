import { blogRssResponse } from "@/lib/blogFeed";

/** The shop's RSS feed on its Cacaduu address (/{lang}/shops/{slug}/blog/rss.xml; the feed is in the shop's language). */
export async function GET(_request: Request, ctx: RouteContext<"/[lang]/shops/[slug]/blog/rss.xml">) {
  const { slug } = await ctx.params;
  return await blogRssResponse(slug, false);
}
