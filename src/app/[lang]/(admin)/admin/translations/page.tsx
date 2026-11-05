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
import { SelectSubmit } from "@/components/SelectSubmit";
import { SaveBar } from "@/components/owner/SaveBar";
import { cardClass, fieldClass, ghostClass } from "@/components/owner/ui";
import { forwardScript } from "@/lib/adminPages";
import { AdminHead } from "../_parts/common";
import { saveLanguages, saveUiText } from "./actions";
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
 * "Admin → Preklady" (database update 40; artboard 8 since 2026-11-05; only profiles.is_admin, checked again by
 * is_admin() in SQL): 1) "Jazyky" — each language on or off and pre-translated or not, one form with the save bar (only
 * changed rows are saved); 2) "Preklady rozhrania" — the interface texts of a language
 * (Slovak is the source; sk, hu, en are written in the repository): "Preložiť chýbajúce texty", search, edit, mark
 * checked (legal texts carry "Strojový preklad – záväzná je slovenská verzia" until then); 3) the AI cost per month.
 * The plans' numbers of pre-translated languages are on Limity plánov since 2026-11-05 (an old #limits link goes there).
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

  const [rowsResult, usageResult] = await Promise.all([
    supabase.rpc("admin_ui_translations", { p_lang: target }),
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
  const usage = (usageResult.data ?? []) as { month: string; calls: number; input_tokens: number; output_tokens: number; cost_eur: number; alerted_at: string | null }[];
  const ok = first(sp.ok);
  const err = first(sp.err);
  const stateLabel: Record<string, string> = { missing: a.state_missing, stale: a.state_stale, unchecked: a.state_unchecked, checked: a.state_checked };

  const filterHref = (f: string) =>
    `/${lang}/admin/translations?${new URLSearchParams({ target, ...(q ? { q } : {}), ...(f ? { filter: f } : {}) })}#ui`;
  const segment = (on: boolean) =>
    `flex min-h-11 flex-none items-center whitespace-nowrap rounded-[10px] px-3.5 text-[15px] font-bold no-underline ${on ? "bg-[#111] text-white" : "text-[#3D3D3D] hover:bg-[#F4F4F4]"}`;
  const enabledCount = languages.filter((l) => l.enabled).length;
  const indexedCount = languages.filter((l) => l.indexed).length;
  const money = (n: number) => new Intl.NumberFormat(lang, { style: "currency", currency: "EUR" }).format(n);

  return (
    <div className="flex flex-col gap-4">
      {/* an old link to the plans' languages (#limits) goes to Limity plánov */}
      <script dangerouslySetInnerHTML={{ __html: forwardScript("/admin/translations") }} />
      <div>
        <AdminHead dict={dict} page="translations" intro={a.intro} />
        {(ok || err) && (
          <p role={ok ? "status" : "alert"} className={`mb-4 rounded-xl border p-3 ${ok ? "border-[#111] font-semibold" : "border-[#D6D6D6]"}`}>
            {ok ? a.saved : t(dict.account.error, { message: err ?? "" })}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <form action={saveLanguages} className={`${cardClass} min-w-0 !gap-0`}>
            <input type="hidden" name="lang" value={lang} />
            <input type="hidden" name="keep" value={keep} />
            <section id="languages" className="flex min-w-0 scroll-mt-4 flex-col" aria-labelledby="languages-heading">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 id="languages-heading" className="text-[19px] font-bold">
                  {a.languages_title}
                </h2>
                <span className="text-sm text-[#5C5C5C]">{t(a.languages_count, { all: languages.length, on: enabledCount, ahead: indexedCount })}</span>
              </div>
              <p className="pb-3 pt-1 text-sm text-[#5C5C5C]">{a.languages_help}</p>
              <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] gap-x-3 pb-1.5 text-xs font-bold uppercase tracking-[.04em] text-[#5C5C5C]" aria-hidden="true">
                <span>{a.language_col}</span>
                <span className="text-center">{a.enabled}</span>
                <span className="text-center">{a.indexed}</span>
              </div>
              <ul className="flex flex-col">
                {languages.map((l) => {
                  const info = languageOf(l.code);
                  const name = info?.native ?? l.code;
                  return (
                    <li key={l.code} className="grid min-h-14 grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-center gap-x-3 border-t border-[#E4E4E4] py-1.5 text-[15px]" data-admin-language={l.code}>
                      <input type="hidden" name="codes" value={l.code} />
                      <input type="hidden" name={`was:${l.code}`} value={`${l.enabled ? 1 : 0}${l.indexed ? 1 : 0}`} />
                      <span className="min-w-0" lang={l.code}>
                        <strong>{name}</strong> <span className="text-xs uppercase text-[#5C5C5C]">{l.code}</span>
                      </span>
                      <span className="flex justify-center">
                        <input type="checkbox" name={`${l.code}:enabled`} aria-label={`${a.enabled}: ${name}`} defaultChecked={l.enabled} disabled={l.code === "sk"} className="ppi-toggle" />
                      </span>
                      <span className="flex justify-center">
                        <input type="checkbox" name={`${l.code}:indexed`} aria-label={`${a.indexed}: ${name}`} defaultChecked={l.indexed} disabled={l.code === "sk"} className="ppi-toggle" />
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
            <SaveBar labels={{ unsaved: dict.owner.unsaved, cancel: dict.owner.cancel_changes, save: a.save, saving: dict.owner.saving }} />
          </form>

          <section id="usage" className={`${cardClass} min-w-0 scroll-mt-4`} aria-labelledby="usage-heading">
            <h2 id="usage-heading" className="text-[19px] font-bold">
              {a.usage_title}
            </h2>
            {usage.length === 0 ? (
              <p className="text-sm text-[#5C5C5C]">{a.usage_none}</p>
            ) : (
              <ul className="flex flex-col">
                {usage.map((u) => (
                  <li key={u.month} className="flex min-h-14 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-t border-[#E4E4E4] py-2 text-[15px]" data-usage-month={u.month}>
                    <span className="flex flex-col">
                      <strong>{formatDate(`${u.month}T12:00:00Z`, lang, "UTC")}</strong>
                      <span className="text-[13px] text-[#5C5C5C]">
                        {t(a.usage_line, { calls: u.calls, tokens: (Number(u.input_tokens) + Number(u.output_tokens)).toLocaleString(lang) })}
                      </span>
                    </span>
                    <span className="flex flex-col items-end">
                      <strong className="tabular-nums">{money(Number(u.cost_eur))}</strong>
                      {u.alerted_at && <span className="text-[13px] text-[#5C5C5C]">{a.usage_alerted}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-sm text-[#5C5C5C]">{a.budget_help}</p>
          </section>
        </div>

        <section id="ui" className={`${cardClass} min-w-0 scroll-mt-4`} aria-labelledby="ui-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="ui-heading" className="text-[19px] font-bold">
              {a.ui_title}
            </h2>
            <UiTranslateButton
              target={target}
              todo={counts.missing + counts.stale}
              labels={{ button: a.translate_missing, progress: a.progress, done: a.done, failed: a.failed }}
            />
          </div>
          <form method="get" className="flex flex-wrap items-center gap-2.5" role="search">
            {filter && <input type="hidden" name="filter" value={filter} />}
            <SelectSubmit
              name="target"
              value={target}
              label={a.target}
              options={generated.map((l) => ({ value: l.code, label: l.native }))}
              className={`${fieldClass} !min-h-11 !w-auto flex-none !py-0 !text-[15px] font-bold`}
              data="ui-target"
            />
            <label className="flex min-w-0 flex-1 basis-48">
              <span className="sr-only">{a.search}</span>
              <input type="search" name="q" defaultValue={q} placeholder={a.search} className={`${fieldClass} !min-h-11 !py-2 !text-[15px]`} />
            </label>
            <noscript>
              <button type="submit" className={`${ghostClass} !min-h-11 !px-4 !text-[15px]`}>
                {a.show}
              </button>
            </noscript>
          </form>
          <nav aria-label={a.filter} className="flex max-w-full gap-1 self-start overflow-x-auto rounded-xl border border-[#D6D6D6] p-1 [scrollbar-width:none]" data-ui-filter>
            {(["", "missing", "stale", "unchecked", "checked"] as const).map((f) => (
              <a key={f || "all"} href={filterHref(f)} aria-current={filter === f ? "true" : undefined} className={segment(filter === f)} data-ui-filter-value={f || "all"}>
                {f ? `${stateLabel[f]} ${counts[f]}` : `${a.all} ${keys.length}`}
              </a>
            ))}
          </nav>
          <p className="text-sm text-[#5C5C5C]" data-ui-counts>
            {a.ui_help}
          </p>
          <ul className="flex flex-col">
            {visible.map((key) => {
              const row = stored.get(key);
              const state = stateOf(key);
              return (
                <li key={key} id={`key-${key}`} className="flex scroll-mt-4 flex-col gap-2 border-t border-[#E4E4E4] py-3" data-ui-key={key}>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <code className="break-all font-mono text-[#5C5C5C]">{key}</code>
                    <span className="rounded-full border border-[#E4E4E4] px-2.5 py-0.5 font-semibold" data-ui-state={state}>
                      {stateLabel[state]}
                    </span>
                    {isLegalKey(key) && <span className="text-[#5C5C5C]">{a.legal}</span>}
                  </div>
                  <p className="text-[15px] font-semibold">{skFlat[key]}</p>
                  {enFlat[key] && <p className="text-sm text-[#5C5C5C]">EN: {enFlat[key]}</p>}
                  <form action={saveUiText} className="flex flex-col gap-2">
                    <input type="hidden" name="lang" value={lang} />
                    <input type="hidden" name="target" value={target} />
                    <input type="hidden" name="key" value={key} />
                    <input type="hidden" name="keep" value={keep} />
                    <textarea
                      name="text"
                      aria-label={`${a.translation_of} ${key}`}
                      placeholder={a.translation_placeholder}
                      defaultValue={row?.text ?? ""}
                      rows={Math.min(6, Math.max(1, Math.ceil(skFlat[key].length / 60)))}
                      lang={target}
                      className={`${fieldClass} !min-h-11 !py-2 !text-[15px] leading-snug`}
                    />
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <label className="flex min-h-11 items-center gap-3 text-[15px] font-semibold">
                        <input type="checkbox" name="checked" defaultChecked={row?.checked ?? false} className="ppi-toggle" />
                        {a.checked}
                      </label>
                      <button type="submit" className={`${ghostClass} !min-h-11 !px-4 !text-[15px]`}>
                        {a.save}
                      </button>
                    </div>
                  </form>
                </li>
              );
            })}
          </ul>
          {pages > 1 && (
            <nav className="flex items-center justify-between gap-3 border-t border-[#E4E4E4] pt-3 text-[15px]">
              {page > 1 ? (
                <a href={pageUrl(page - 1)} className={`${ghostClass} !min-h-11 !px-4 !text-[15px]`}>
                  {dict.shop.prev}
                </a>
              ) : (
                <span />
              )}
              <span className="text-[#5C5C5C]">{t(dict.shop.page_of, { page, pages })}</span>
              {page < pages ? (
                <a href={pageUrl(page + 1)} className={`${ghostClass} !min-h-11 !px-4 !text-[15px]`}>
                  {dict.shop.next}
                </a>
              ) : (
                <span />
              )}
            </nav>
          )}
        </section>
      </div>
    </div>
  );
}
