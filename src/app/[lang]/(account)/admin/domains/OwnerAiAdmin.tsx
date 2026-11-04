import { t, type Dictionary } from "@/i18n/dictionaries";
import { saveOwnerAi } from "./actions";

export interface OwnerAiInfo {
  grammar_daily_limit: number;
  today: Record<string, { calls: number; input: number; output: number }>;
  month: Record<string, { calls: number; input: number; output: number }>;
}

/**
 * "AI pre majiteľov" on the admin page (database update 76): the daily limit of "Opraviť gramatiku" per shop, and how
 * much the owners' AI tools were used today and this month (calls and tokens — the AI spend). The website's AI
 * pomocník uses the Telegram bot's switch and daily limit (one limit for the website and Telegram), set on that card.
 */
export function OwnerAiAdmin({ info, aiKey, dict, hidden }: { info: OwnerAiInfo | null; aiKey: boolean; dict: Dictionary; hidden: React.ReactNode }) {
  const a = dict.admin_owner_ai;
  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
  const line = (text: string, x: OwnerAiInfo["today"]) =>
    t(text, {
      g: x.grammar?.calls ?? 0,
      gt: (x.grammar?.input ?? 0) + (x.grammar?.output ?? 0),
      a: x.assistant?.calls ?? 0,
      at: (x.assistant?.input ?? 0) + (x.assistant?.output ?? 0),
    });
  return (
    <section id="owner-ai" className="flex flex-col gap-3" aria-labelledby="owner-ai-heading" data-admin-owner-ai>
      <h2 id="owner-ai-heading" className="text-lg font-semibold">
        {a.title}
      </h2>
      <p className="text-sm text-muted">{a.intro}</p>
      {!aiKey && <p className="text-sm font-semibold">{a.no_key}</p>}
      {info === null ? (
        <p className="text-sm text-muted">{a.unavailable}</p>
      ) : (
        <>
          <p className="text-sm">{line(a.today, info.today)}</p>
          <p className="text-sm">{line(a.month, info.month)}</p>
          <form action={saveOwnerAi} className="flex flex-wrap items-end gap-3 text-sm" data-owner-ai-settings>
            {hidden}
            <label className="flex flex-col gap-1">
              <span>{a.grammar_limit}</span>
              <input name="grammar_daily_limit" type="number" min={0} max={1000} required defaultValue={info.grammar_daily_limit} className={`${input} w-28`} />
            </label>
            <button type="submit" className="rounded border border-foreground px-3 py-2 font-medium">
              {a.save}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
