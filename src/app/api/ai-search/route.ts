import { isLocale, type Locale } from "@/i18n/config";
import { aiSearchAllowed, aiSearchEnabled, NoAnswerError, plainResults, runChatSearch } from "@/lib/aiSearch";
import { getSession } from "@/lib/auth";
import { type ChatEvent, cleanHistory, MAX_QUESTION } from "@/lib/chatProtocol";

/**
 * POST {q, lang, history, plain?} from the main page's chat (Prompt 10). Answers NDJSON, one event
 * per line, as things happen: the real steps, the answer's words, then the cards built from the
 * search results. Whenever the AI cannot answer — no key, a limit, an error, no answer started
 * within 12 seconds — the plain database search goes out instead ({type: "fallback"}) and the
 * page shows "Zobrazujem jednoduché výsledky vyhľadávania.". Shoppers never see why; a logged-in
 * shop owner gets the reason, and every reason is logged (Vercel → Logs, "ai-search"). When the
 * shopper stops ("Zastaviť", Esc) the browser cancels the request and the AI call stops with it.
 * The server keeps no conversation: the browser sends the last few turns. No CORS headers: only
 * the website itself calls this.
 */
export const maxDuration = 60;

const NDJSON = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" };

export async function POST(request: Request) {
  let body: { q?: unknown; lang?: unknown; history?: unknown; plain?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const question = typeof body?.q === "string" ? body.q.trim().slice(0, MAX_QUESTION) : "";
  const lang = typeof body?.lang === "string" && isLocale(body.lang) ? (body.lang as Locale) : null;
  if (question.length < 2 || !lang) return Response.json({ error: "bad_request" }, { status: 400 });
  const history = cleanHistory(body.history);

  const stopped = new AbortController();
  request.signal?.addEventListener("abort", () => stopped.abort());
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) => {
        if (stopped.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          stopped.abort();
        }
      };
      const fallback = async (reason: string, limited = false) => {
        if (stopped.signal.aborted) return;
        console.error(`ai-search: ${reason}`);
        const [owner, results] = await Promise.all([
          getSession().catch(() => null),
          plainResults(question, lang).catch((e) => {
            console.error(`ai-search: the plain search failed too: ${e instanceof Error ? e.message : String(e)}`);
            return { cards: [], shops: {}, searched: [question] };
          }),
        ]);
        emit({ type: "fallback", limited, ...(owner ? { reason } : {}), ...results });
      };

      try {
        if (body.plain === true) await fallback("the page asked for the plain search (the AI answer did not arrive)");
        else if (!aiSearchEnabled()) await fallback("ANTHROPIC_API_KEY is not set in Vercel");
        else {
          const allowed = await aiSearchAllowed(request);
          if (!allowed.ok) await fallback(allowed.reason, allowed.limited);
          else {
            try {
              await runChatSearch({ question, history, lang, signal: stopped.signal, emit });
            } catch (e) {
              if (!stopped.signal.aborted) {
                await fallback(e instanceof NoAnswerError ? e.message : `Claude: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
              }
            }
          }
        }
        emit({ type: "done" });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed: the shopper stopped the answer
        }
      }
    },
    cancel() {
      // The browser stopped reading ("Zastaviť", Esc, a new chat, leaving the page): stop the AI call too.
      stopped.abort();
    },
  });
  return new Response(stream, { headers: NDJSON });
}
