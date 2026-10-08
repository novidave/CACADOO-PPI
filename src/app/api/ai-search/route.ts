import { isLocale } from "@/i18n/config";
import { aiSearchAllowed, aiSearchEnabled, runAiSearch } from "@/lib/aiSearch";
import { getSession } from "@/lib/auth";

/**
 * POST {q, lang, only} from the main page's AI layer. Anything that goes wrong — no key,
 * over the limit, an error — answers {fallback: true} and the page simply keeps the
 * plain results. Shoppers never see why; a logged-in shop owner gets the reason, so the
 * AI search can be tested, and every reason is logged (Vercel → Logs, "ai-search").
 * No CORS headers: only the PPI website itself calls this.
 */
export const maxDuration = 60;

const reply = (body: unknown) => Response.json(body, { headers: { "Cache-Control": "no-store" } });

async function fallback(reason: string) {
  console.error(`ai-search: ${reason}`);
  const owner = await getSession().catch(() => null);
  return reply(owner ? { fallback: true, reason } : { fallback: true });
}

export async function POST(request: Request) {
  if (!aiSearchEnabled()) return fallback("ANTHROPIC_API_KEY is not set in Vercel");
  let body: { q?: unknown; lang?: unknown; only?: unknown };
  try {
    body = await request.json();
  } catch {
    return fallback("the request was not JSON");
  }
  const question = typeof body?.q === "string" ? body.q.trim().slice(0, 300) : "";
  const lang = typeof body?.lang === "string" ? body.lang : "";
  if (question.length < 2 || !isLocale(lang)) return fallback("the question is too short");
  const allowed = await aiSearchAllowed(request);
  if (!allowed.ok) return fallback(allowed.reason);
  try {
    return reply(await runAiSearch(question, lang, body.only === true));
  } catch (e) {
    return fallback(`Claude: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
  }
}
