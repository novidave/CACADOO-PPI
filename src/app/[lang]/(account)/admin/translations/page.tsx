import type { Metadata } from "next";
import { createHash } from "node:crypto";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, siteLanguages, t } from "@/i18n/dictionaries";
import { HANDWRITTEN, LANGUAGES, languageOf } from "@/i18n/languages";
import { flatten, isLegalKey } from "@/i18n/messages";
import en from "@/i18n/messages/en.json";
import sk from "@/i18n/messages/sk.json";
import { requireUser } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { saveLanguage, saveLimits, saveUiText } from "./actions";
import { UiTranslateButton } from "./UiTranslateButton";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/translations">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).admin_tr.title };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const PER_PAGE = 40;
const md5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex");

interface UiRow {
  key: string;
  text: string;
  source_hash: string;
  status: "ai" | "manual";
  checked: boolean;
}

/**
 * "Admin → Preklady" (database update 40; only profiles.is_admin, checked again by is_admin() in SQL): 1) "Jazyky" —
 * each language on or off and pre-translated or not; 2) "Preklady rozhrania" — the interface texts of a language
 * (Slovak is the source; sk, hu, en are written in the repository): "Preložiť chýbajúce texty", search, edit, mark
 * checked (legal texts carry "Strojový preklad – záväzná je slovenská verzia" until then); 3) the plans' numbers of
 * pre-translated languages and the AI cost per month.
 */
export default async function AdminTranslationsPage({ params, searchParams }: PageProps<"/[lang]/admin/translations">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session, languages] = await Promise.all([getDictionary(lang), requireUser(lang), siteLanguages()]);
  if (!session.isAdmin) notFound();
  const a = dict.admin_tr;
  const { supabase } = session;

  const generated = LANGUAGES.filter((l) => !(HANDWRITTEN as readonly string[]).includes(l.code));
  const target = generated.find((l) => l.code === first(sp.target))?.code ?? "de";
  const q = (first(sp.q) ?? "").trim().toLowerCase();
  const filter = first(sp.filter) ?? "";
  const page = Math.max(1, Number(first(sp.page)) || 1);

  const [rowsResult, limitsResult, usageResult] = await Promise.all([
    supabase.rpc("admin_ui_translations", { p_lang: target }),
    supabase.rpc("admin_translation_limits"),
    supabase.rpc("admin_translation_usage"),
  ]);
  if (rowsResult.error) return <DbError message={rowsResult.error.message} dict={dict} />;
  const stored = new Map(((rowsResult.data ?? []) as UiRow[]).map((r) => [r.key, r]));
  const skFlat = flatten(sk as never) as Record<string, string>;
  const enFlat = flatten(en as never) as Record<string, string>;
  const keys = Object.keys(skFlat).filter((k) => skFlat[k].trim());
  const stateOf = (key: string) => {
    const row = stored.get(key);
    if (!row) return "missing" as const;
    if (row.source_hash !== md5(skFlat[key])) return "stale" as const;
    return row.checked ? ("checked" as const) : ("unchecked" as const);
  };
  const counts = { missing: 0, stale: 0, unchecked: 0, checked: 0 };
  for (const k of keys) counts[stateOf(k)]++;
  const shown = keys.filter(
    (k) =>
      (!filter || stateOf(k) === filter) &&
      (!q || k.includes(q) || skFlat[k].toLowerCase().includes(q) || (stored.get(k)?.text ?? "").toLowerCase().includes(q)),
  );
  const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
  const visible = shown.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const keep = `?${new URLSearchParams({ target, ...(q ? { q } : {}), ...(filter ? { filter } : {}), page: String(page) })}`;
  const pageUrl = (n: number) => `/${lang}/admin/translations?${new URLSearchParams({ target, ...(q ? { q } : {}), ...(filter ? { filter } : {}), page: String(n) })}#ui`;
  const limits = (limitsResult.data ?? []) as { plan: "free" | "pro"; max_preferred: number }[];
  const usage = (usageResult.data ?? []) as { month: string; calls: number; input_tokens: number; output_tokens: number; cost_eur: number; alerted_at: string | null }[];
  const ok = first(sp.ok);
  const err = first(sp.err);
  const stateLabel: Record<string, string> = { missing: a.state_missing, stale: a.state_stale, unchecked: a.state_unchecked, checked: a.state_checked };

  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{a.title}</h1>
        <p className="text-sm">{a.intro}</p>
        {(ok || err) && (
          <p role="status" className={ok ? "border border-foreground p-3 font-medium" : "border border-line p-3"}>
            {ok ? a.saved : t(dict.account.error, { message: err ?? "" })}
          </p>
        )}
      </header>

      <section id="languages" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{a.languages_title}</h2>
        <p className="text-sm text-muted">{a.languages_help}</p>
        <ul className="divide-y divide-line border-y border-line">
          {languages.map((l) => {
            const info = languageOf(l.code);
            return (
              <li key={l.code} className="py-2">
                <form action={saveLanguage} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" data-admin-language={l.code}>
                  <input type="hidden" name="lang" value={lang} />
                  <input type="hidden" name="code" value={l.code} />
                  <input type="hidden" name="keep" value={keep} />
                  <span className="min-w-40 font-medium" lang={l.code}>
                    {info?.native ?? l.code} <span className="text-xs uppercase text-muted">{l.code}</span>
                  </span>
                  <label className="flex items-center gap-1">
                    <input type="checkbox" name="enabled" defaultChecked={l.enabled} disabled={l.code === "sk"} />
                    {a.enabled}
                  </label>
                  <label className="flex items-center gap-1">
                    <input type="checkbox" name="indexed" defaultChecked={l.indexed} disabled={l.code === "sk"} />
                    {a.indexed}
                  </label>
                  {l.code !== "sk" && <PendingButton pending={dict.owner.saving}>{a.save}</PendingButton>}
                </form>
              </li>
            );
          })}
        </ul>
      </section>

      <section id="ui" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{a.ui_title}</h2>
        <p className="text-sm text-muted">{a.ui_help}</p>
        <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-muted">{a.target}</span>
            <select name="target" defaultValue={target} className="rounded border border-line px-2 py-2" data-ui-target>
              {generated.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.native}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted">{a.filter}</span>
            <select name="filter" defaultValue={filter} className="rounded border border-line px-2 py-2">
              <option value="">{a.all}</option>
              {(["missing", "stale", "unchecked", "checked"] as const).map((s) => (
                <option key={s} value={s}>
                  {stateLabel[s]} ({counts[s]})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted">{a.search}</span>
            <input type="search" name="q" defaultValue={q} className="rounded border border-line px-2 py-2" />
          </label>
          <button type="submit" className="rounded border border-foreground px-3 py-2">
            {a.show}
          </button>
        </form>
        <p className="text-sm" data-ui-counts>
          {t(a.counts, { all: keys.length, missing: counts.missing, stale: counts.stale, unchecked: counts.unchecked })}
        </p>
        <UiTranslateButton
          target={target}
          todo={counts.missing + counts.stale}
          labels={{ button: a.translate_missing, progress: a.progress, done: a.done, failed: a.failed }}
        />
        <ul className="divide-y divide-line border-y border-line">
          {visible.map((key) => {
            const row = stored.get(key);
            const state = stateOf(key);
            return (
              <li key={key} id={`key-${key}`} className="flex flex-col gap-2 py-3" data-ui-key={key}>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <code className="font-mono">{key}</code>
                  <span className="rounded-full border border-line px-2 py-0.5 font-semibold" data-ui-state={state}>
                    {stateLabel[state]}
                  </span>
                  {isLegalKey(key) && <span className="text-muted">{a.legal}</span>}
                </div>
                <p className="text-sm">
                  <span className="text-muted">SK: </span>
                  {skFlat[key]}
                </p>
                {enFlat[key] && (
                  <p className="text-sm text-muted">
                    <span>EN: </span>
                    {enFlat[key]}
                  </p>
                )}
                <form action={saveUiText} className="flex flex-col gap-2">
                  <input type="hidden" name="lang" value={lang} />
                  <input type="hidden" name="target" value={target} />
                  <input type="hidden" name="key" value={key} />
                  <input type="hidden" name="keep" value={keep} />
                  <textarea name="text" defaultValue={row?.text ?? ""} rows={Math.min(6, Math.max(1, Math.ceil(skFlat[key].length / 80)))} lang={target} className="rounded border border-line px-3 py-2 text-sm" />
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <label className="flex items-center gap-1">
                      <input type="checkbox" name="checked" defaultChecked={row?.checked ?? false} />
                      {a.checked}
                    </label>
                    <PendingButton pending={dict.owner.saving}>{a.save}</PendingButton>
                  </div>
                </form>
              </li>
            );
          })}
        </ul>
        {pages > 1 && (
          <nav className="flex items-center justify-between text-sm">
            {page > 1 ? <a href={pageUrl(page - 1)} className="underline">{dict.shop.prev}</a> : <span />}
            <span className="text-muted">{t(dict.shop.page_of, { page, pages })}</span>
            {page < pages ? <a href={pageUrl(page + 1)} className="underline">{dict.shop.next}</a> : <span />}
          </nav>
        )}
      </section>

      <section id="limits" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{a.limits_title}</h2>
        <p className="text-sm text-muted">{a.limits_help}</p>
        <form action={saveLimits} className="flex flex-wrap items-end gap-3 text-sm" data-translation-limits>
          <input type="hidden" name="lang" value={lang} />
          <input type="hidden" name="keep" value={keep} />
          {(["free", "pro"] as const).map((plan) => (
            <label key={plan} className="flex flex-col gap-1">
              <span className="text-muted">{plan === "free" ? a.limit_free : a.limit_pro}</span>
              <input type="number" name={plan} min={0} max={42} defaultValue={limits.find((l) => l.plan === plan)?.max_preferred ?? (plan === "free" ? 2 : 6)} className="w-24 rounded border border-line px-2 py-2" />
            </label>
          ))}
          <PendingButton pending={dict.owner.saving}>{a.save}</PendingButton>
        </form>
        <h3 className="font-semibold">{a.usage_title}</h3>
        <p className="text-sm text-muted">{a.budget_help}</p>
        {usage.length === 0 ? (
          <p className="text-sm text-muted">{a.usage_none}</p>
        ) : (
          <table className="w-full max-w-xl text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="py-1 pr-2 font-normal">{a.usage_month}</th>
                <th className="py-1 pr-2 text-right font-normal">{a.usage_calls}</th>
                <th className="py-1 pr-2 text-right font-normal">{a.usage_tokens}</th>
                <th className="py-1 text-right font-normal">{a.usage_cost}</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.month} className="border-b border-line">
                  <td className="py-1 pr-2">{formatDate(`${u.month}T12:00:00Z`, lang, "UTC")}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{u.calls}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{(Number(u.input_tokens) + Number(u.output_tokens)).toLocaleString(lang)}</td>
                  <td className="py-1 text-right tabular-nums">
                    {new Intl.NumberFormat(lang, { style: "currency", currency: "EUR" }).format(Number(u.cost_eur))}
                    {u.alerted_at ? ` · ${a.usage_alerted}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
