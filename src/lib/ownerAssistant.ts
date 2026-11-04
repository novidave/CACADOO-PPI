import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { Dictionary } from "@/i18n/dictionaries";
import { aiModel } from "@/lib/aiModel";
import type { Ai, AiBlock, AssistantLang } from "@/lib/ownerAssistantCore";

/**
 * The website's side of the owner's AI assistant (database update 76): Claude for the shared engine
 * (@/lib/ownerAssistantCore — the same one the Telegram bot runs), and the owner's words for a refusal.
 */

/** Claude (AI_MODEL) for one request of the engine; the request stops with the owner's "Zastaviť". Null without the key. */
export function claudeAssistant(signal?: AbortSignal): Ai | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ maxRetries: 1, timeout: 25_000 });
  return async ({ system, messages, tools }) => {
    const message = await client.messages.create(
      {
        model: aiModel(),
        max_tokens: 1500,
        output_config: { effort: "low" },
        system,
        messages: messages as Anthropic.MessageParam[],
        tools: tools as Anthropic.Tool[],
      },
      { signal },
    );
    return {
      stop_reason: message.stop_reason,
      content: message.content as unknown as AiBlock[],
      usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
    };
  };
}

/** The engine's language for a page language (Czech → Slovak; anything else English). */
export function assistantLang(lang: string): AssistantLang {
  const c = lang.toLowerCase().slice(0, 2);
  return c === "sk" || c === "cs" ? "sk" : c === "hu" ? "hu" : "en";
}

/** A text of the "telegram" namespace (the engine's before → after lines) in the owner's language. */
export function assistantTexts(dict: Dictionary) {
  const texts = dict.telegram as Record<string, string>;
  return (key: string, vars: Record<string, string | number> = {}) =>
    (texts[key] ?? key).replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all));
}

/** A database refusal of the one door as the owner reads it (the bot's words). */
export function assistantRefusal(dict: Dictionary, message: string): string {
  const t = assistantTexts(dict);
  const reason = message.split(":")[0].trim();
  if (reason === "scope") return t("err_scope");
  if (reason === "no_plan") return t("err_no_plan");
  if (reason === "not_found") return t("err_not_found");
  if (reason === "expired") return t("expired");
  if (reason === "used") return t("used");
  if (reason === "hours" || reason === "bad_argument") return t("err_hours");
  if (reason === "sklad_active") return t("stock_sklad");
  return t("err_failed");
}
