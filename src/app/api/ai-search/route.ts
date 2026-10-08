import { isLocale } from "@/i18n/config";
import { aiSearchAllowed, aiSearchEnabled, runAiSearch } from "@/lib/aiSearch";

/**
 * POST {q, lang, only} from the main page's AI layer. Anything that goes wrong — no key,
 * over the limit, an error — answers {fallback: true} and the page simply keeps the
 * plain results. No CORS headers: only the PPI website itself calls this.
 */
export const maxDuration = 60;

const reply = (body: unknown) => Response.json(body, { headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  if (!aiSearchEnabled()) return reply({ fallback: true });
  let body: { q?: unknown; lang?: unknown; only?: unknown };
  try {
    body = await request.json();
  } catch {
    return reply({ fallback: true });
  }
  const question = typeof body?.q === "string" ? body.q.trim().slice(0, 300) : "";
  const lang = typeof body?.lang === "string" ? body.lang : "";
  if (question.length < 2 || !isLocale(lang)) return reply({ fallback: true });
  if (!(await aiSearchAllowed(request))) return reply({ fallback: true });
  try {
    return reply(await runAiSearch(question, lang, body.only === true));
  } catch (e) {
    console.error("ai-search", e instanceof Error ? e.message : e);
    return reply({ fallback: true });
  }
}
