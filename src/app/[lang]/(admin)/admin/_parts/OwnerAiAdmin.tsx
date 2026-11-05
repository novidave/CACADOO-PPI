import { t, type Dictionary } from "@/i18n/dictionaries";
import { HEALTH_COLORS } from "@/lib/adminOverview";
import { cardClass } from "@/components/owner/ui";
import { SaveBar } from "@/components/owner/SaveBar";
import { saveOwnerAi } from "./actions";
import { DotText, numClass, saveLabels, SettingRow } from "./common";

export interface OwnerAiInfo {
  grammar_daily_limit: number;
  /** Update 77: the blog editor's AI per shop and day (missing before it). */
  blog_daily_limit?: number;
  today: Record<string, { calls: number; input: number; output: number }>;
  month: Record<string, { calls: number; input: number; output: number }>;
}

type Usage = OwnerAiInfo["today"];

/**
 * "AI pre majiteľov" (database update 76; artboard 7 since 2026-11-05): whether the website has the AI key, the daily
 * limits per shop ("Opraviť gramatiku", since update 77 the blog editor's AI) with the save bar, and how much the
 * owners' AI tools were used today and this month (calls per tool and tokens — the AI spend). The website's AI
 * pomocník uses the Telegram bot's switch and daily limit (one limit for the website and Telegram), set on that card.
 */
export function OwnerAiAdmin({ info, aiKey, lang, dict, hidden }: { info: OwnerAiInfo | null; aiKey: boolean; lang: string; dict: Dictionary; hidden: React.ReactNode }) {
  const a = dict.admin_owner_ai;
  const tokens = (x: Usage) => Object.values(x).reduce((sum, v) => sum + (v?.input ?? 0) + (v?.output ?? 0), 0);
  const usage = (head: string, x: Usage) => (
    <span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5 rounded-xl bg-[#F4F4F4] px-3.5 py-3 text-sm">
      <span className="text-xs font-bold uppercase tracking-[.04em] text-[#5C5C5C]">{head}</span>
      <span>
        {t(a.usage_line, { g: x.grammar?.calls ?? 0, a: x.assistant?.calls ?? 0, b: x.blog?.calls ?? 0 })}
      </span>
      <span className="text-[13px] text-[#5C5C5C]">{t(a.usage_tokens, { n: new Intl.NumberFormat(lang).format(tokens(x)) })}</span>
    </span>
  );
  return (
    <section id="owner-ai" className={`${cardClass} min-w-0 !gap-0`} aria-labelledby="owner-ai-heading" data-admin-owner-ai>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="owner-ai-heading" className="text-[19px] font-bold">
          {a.title}
        </h2>
        <DotText color={aiKey ? HEALTH_COLORS.ok : HEALTH_COLORS.off}>{aiKey ? dict.admin_home.svc_key_set : dict.admin_home.svc_key_missing}</DotText>
      </div>
      <p className="pb-3 pt-1 text-sm text-[#5C5C5C]">{a.intro}</p>
      {!aiKey && <p className="pb-3 text-sm font-semibold">{a.no_key}</p>}
      {info === null ? (
        <p className="text-sm text-[#5C5C5C]">{a.unavailable}</p>
      ) : (
        <form action={saveOwnerAi} className="flex flex-col" data-owner-ai-settings>
          {hidden}
          <SettingRow label={a.grammar_label} hint={a.zero_off}>
            <input name="grammar_daily_limit" type="number" min={0} max={1000} required aria-label={a.grammar_limit} defaultValue={info.grammar_daily_limit} className={numClass} />
          </SettingRow>
          {info.blog_daily_limit !== undefined && (
            <SettingRow label={a.blog_label} hint={a.zero_off}>
              <input name="blog_daily_limit" type="number" min={0} max={1000} required aria-label={a.blog_limit} defaultValue={info.blog_daily_limit} className={numClass} />
            </SettingRow>
          )}
          <div className="flex flex-wrap gap-2.5 border-t border-[#E4E4E4] py-3" data-owner-ai-usage>
            {usage(a.usage_today, info.today)}
            {usage(a.usage_month, info.month)}
          </div>
          <SaveBar labels={saveLabels(dict, a.save)} />
        </form>
      )}
    </section>
  );
}
