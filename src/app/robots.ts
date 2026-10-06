import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

// Everyone may read the public pages, AI crawlers explicitly included.
// Login-only pages are kept out.
const disallow = ["/*/dashboard", "/*/admin", "/*/login", "/*/sync", "/auth/"];
const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "CCBot"];

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
