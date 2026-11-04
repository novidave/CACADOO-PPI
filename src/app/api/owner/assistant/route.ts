import { NextResponse, type NextRequest } from "next/server";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { getSession } from "@/lib/auth";
import type { MyShop } from "@/lib/myShops";
import { AssistantError, runAssistant, type AssistantTurn } from "@/lib/ownerAssistantCore";
import { assistantLang, assistantRefusal, assistantTexts, claudeAssistant } from "@/lib/ownerAssistant";

export const maxDuration = 60;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * The website's AI pomocník (database update 76): one question → the shared engine (@/lib/ownerAssistantCore, the
 * Telegram bot's) with the owner's own grant: reads through assistant_web_call (the owner MCP's one door), proposals
 * through assistant_pending_new (each a "Potvrdiť" card; nothing changes here). Before it: assistant_ai_hit (the
 * admin's AI switch and the daily limit shared with Telegram, a member with the plan); after it: the tokens
 * (owner_ai_spend). "Zastaviť" aborts the request and with it the Claude call. Never logged: the question or the answer.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return json({ error: "login" }, 401);
  const body = (await request.json().catch(() => null)) as { shop?: unknown; lang?: unknown; text?: unknown; history?: unknown } | null;
  const lang = typeof body?.lang === "string" && isLocale(body.lang) ? body.lang : "sk";
  const slug = typeof body?.shop === "string" ? body.shop.slice(0, 100) : "";
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, 2000) : "";
  if (!slug || !text) return json({ error: "failed" }, 400);
  const history: AssistantTurn[] = (Array.isArray(body?.history) ? body.history : [])
    .filter((h): h is AssistantTurn => !!h && ((h as AssistantTurn).r === "u" || (h as AssistantTurn).r === "a") && typeof (h as AssistantTurn).t === "string")
    .slice(-8)
    .map((h) => ({ r: h.r, t: h.t.slice(0, 1000) }));

  const ai = claudeAssistant(request.signal);
  if (!ai) return json({ error: "ai_off" });
  const { supabase } = session;
  const shops = ((await supabase.rpc("my_shops")).data ?? []) as MyShop[];
  const shop = shops.find((s) => s.slug === slug);
  if (!shop) return json({ error: "forbidden" }, 403);
  const hit = await supabase.rpc("assistant_ai_hit", { p_shop: slug });
  if (hit.error) {
    const reason = hit.error.message.split(":")[0];
    return json({ error: ["ai_off", "ai_limit", "no_plan"].includes(reason) ? reason : "failed" });
  }

  const dict = await getDictionary(lang);
  const proposals: { id: string; lines: string[] }[] = [];
  let sklad = false;
  try {
    const out = await runAssistant(
      {
        ai,
        lang: assistantLang(lang),
        channel: "web",
        shop: { slug: shop.slug, name: shop.name, timezone: shop.timezone },
        t: assistantTexts(dict),
        call: async (tool, args = {}) => {
          const { data, error } = await supabase.rpc("assistant_web_call", { p_tool: tool, p_args: { shop: shop.slug, ...args } });
          if (error) throw new AssistantError(assistantRefusal(dict, error.message));
          return ((data as { result?: unknown })?.result ?? {}) as Record<string, unknown>;
        },
        propose: async (tool, args, lines) => {
          const { data, error } = await supabase.rpc("assistant_pending_new", { p_tool: tool, p_args: { shop: shop.slug, ...args }, p_summary: { lines } });
          if (error || typeof data !== "string") throw new AssistantError(assistantRefusal(dict, error?.message ?? "failed"));
          proposals.push({ id: data, lines });
        },
        sklad: async () => {
          sklad = true;
        },
        signal: request.signal,
      },
      history,
      text,
    );
    await supabase.rpc("owner_ai_spend", { p_shop_id: shop.id, p_kind: "assistant", p_input: out.usage.input, p_output: out.usage.output });
    return json({ answer: out.answer, proposals, links: out.links, sklad, left: typeof hit.data === "number" ? hit.data : null, stopped: out.stopped });
  } catch (e) {
    if (request.signal.aborted) return json({ stopped: true, proposals, sklad });
    console.error("assistant: failed", (e instanceof Error ? e.message : String(e)).slice(0, 120));
    return json({ error: "failed", proposals, sklad });
  }
}
