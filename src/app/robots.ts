import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";
import { AI_BOTS } from "@/lib/siteFiles";

// Everyone may read the public pages, AI crawlers explicitly included.
// Login-only pages are kept out.
// The AI search and the shop assistants cost money per question: no crawler should start one.
const disallow = ["/*/dashboard", "/*/admin", "/*/login", "/*/signup", "/*/forgot", "/*/password", "/*/sync", "/*/site/", "/site/", "/auth/", "/api/ai-search", "/api/shops/", "/api/owner/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow },
      { userAgent: AI_BOTS, allow: "/", disallow },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  };
}
