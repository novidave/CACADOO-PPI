import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { localDateTime } from "@/lib/hours";
import { missingColumn } from "@/lib/missingColumn";
import type { MyShop } from "@/lib/myShops";
import { megabytes, POSITIONS, PRO_BEFORE_30, type SectionLimits, type SectionPosition } from "@/lib/sections";
import { HeaderPictureInput } from "@/components/HeaderPictureInput";
import { PendingButton } from "@/components/PendingButton";
import { SectionOrder, type OwnerSectionRow } from "@/components/SectionOrder";
import { SectionUploader } from "@/components/SectionUploader";
import { removeHeaderPicture, updateSection, uploadHeaderPicture } from "./sectionActions";
import type { Supabase } from "./ShopDocuments";

interface Row {
  id: string;
  title: string;
  display: "collapsed" | "open";
  position: SectionPosition;
  sort: number;
  allow_download: boolean;
  visible_from: string | null;
  visible_until: string | null;
  hidden: boolean;
  published: boolean;
  version: number;
  pages: number | null;
  upload_version: number | null;
  upload_error: string | null;
  updated_at: string;
  created_at: string;
  /** "Zobrazenie strán" (database update 29; "slider" before it). */
  page_layout?: "slider" | "stacked";
}

export interface SectionsData {
  rows: Row[];
  plan: boolean;
  today: string;
  /**
   * The shop's plan's limits (database update 30: every shop, the admin's numbers). Before it:
   * Pro's old limits for a shop with the plan, null for a free shop (no sections then).
   */
  limits: SectionLimits | null;
  /** Sections that could be shown but are over the plan's number (the database hides them too). */
  overLimit: Set<string>;
}

interface LimitsRow {
  plan: "free" | "pro";
  max_sections: number;
  max_pages: number;
  max_bytes: number;
}

/** The shop's page sections (database update 28; null before it). */
export async function loadSections(supabase: Supabase, shop: MyShop, plan: boolean): Promise<SectionsData | null> {
  const columns =
    "id, title, display, position, sort, allow_download, visible_from, visible_until, hidden, published, version, pages, upload_version, upload_error, updated_at, created_at";
  const read = (cols: string) => supabase.from("shop_page_sections").select(cols).eq("shop_id", shop.id).order("sort").order("created_at");
  const [first, limitsResult] = await Promise.all([
    read(`${columns}, page_layout`),
    supabase.rpc("owner_section_limits", { p_shop_id: shop.id }),
  ]);
  let { data, error } = first;
  if (missingColumn(error, "page_layout")) ({ data, error } = await read(columns));
  if (error) return null;
  const l = (limitsResult.data as LimitsRow[] | null)?.[0];
  const limits: SectionLimits | null = l
    ? { plan: l.plan === "pro" ? "pro" : "free", maxSections: l.max_sections, maxPages: l.max_pages, maxBytes: l.max_bytes }
    : plan
      ? PRO_BEFORE_30
      : null;
  const rows = (data ?? []) as unknown as Row[];
  const today = localDateTime(new Date(), shop.timezone).date;
  return { rows, plan, today, limits, overLimit: overTheLimit(rows, today, limits) };
}

/** Published, not hidden, a PDF, inside its dates: the sections that could be shown. */
function couldShow(row: Row, today: string): boolean {
  return row.version > 0 && row.published && !row.hidden &&
    !(row.visible_from && row.visible_from > today) && !(row.visible_until && row.visible_until < today);
}

/**
 * The sections over the plan's number, as section_visible() decides for visitors: of those that
 * could be shown, the first N in the owner's order (the positions in their order on the page,
 * then the order within each) are shown, the rest not.
 */
function overTheLimit(rows: Row[], today: string, limits: SectionLimits | null): Set<string> {
  const ordered = rows
    .filter((r) => couldShow(r, today))
    .sort((a, b) =>
      POSITIONS.indexOf(a.position) - POSITIONS.indexOf(b.position) || a.sort - b.sort || a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id));
  return new Set(ordered.slice(limits ? limits.maxSections : 0).map((r) => r.id));
}

export function sectionsSummary(data: SectionsData | null, dict: Dictionary): string {
  const s = dict.sections;
  if (!data) return s.unavailable;
  if (!data.limits) return s.pro_only;
  if (data.rows.length === 0) return s.summary_none;
  return t(s.summary, {
    n: data.rows.length,
    max: Math.max(data.limits.maxSections, data.rows.length),
    shown: data.rows.filter((r) => state(r, data).key === "live").length,
  });
}

/** What the owner reads next to a section (the database decides the same for visitors). */
function state(row: Row, data: SectionsData): { key: string; date?: string } {
  if (row.upload_error) return { key: "error" };
  if (row.version === 0) return { key: row.upload_version ? "processing" : "empty" };
  if (!row.published) return { key: "draft" };
  if (row.hidden) return { key: "hidden" };
  if (!data.limits) return { key: "no_plan" };
  if (row.visible_from && row.visible_from > data.today) return { key: "before", date: row.visible_from };
  if (row.visible_until && row.visible_until < data.today) return { key: "after", date: row.visible_until };
  if (data.overLimit.has(row.id)) return { key: `over_limit_${data.limits.plan}` };
  return { key: "live" };
}

const dateText = (date: string, lang: Locale) =>
  new Intl.DateTimeFormat(lang, { day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

const errorReason = (dict: Dictionary, code: string) => (dict.sections as Record<string, string>)[`error_${code}`] ?? code;

/** Môj obchod → "Sekcie stránky (PDF)" (paid plan). */
export function PageSectionsPanel({
  data,
  shop,
  lang,
  dict,
  hidden,
  notice,
  editId,
  replaceId,
}: {
  data: SectionsData | null;
  shop: MyShop;
  lang: Locale;
  dict: Dictionary;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  notice: React.ReactNode;
  editId: string | null;
  replaceId: string | null;
}) {
  const s = dict.sections;
  if (!data) return <p className="text-sm text-muted">{s.unavailable}</p>;
  const rows = data.rows;
  const limits = data.limits;
  // A free shop's sections have one place on its page (after the opening hours, before the items).
  const free = limits?.plan === "free";
  const fill = (text: string) =>
    limits ? t(text, { max: limits.maxSections, pages: limits.maxPages, mb: megabytes(limits.maxBytes) }) : text;
  const uploaderLabels = {
    ...s,
    format_hint: fill(s.format_hint),
    error_too_big: fill(s.error_too_big),
    error_too_many_pages: free ? `${fill(s.error_too_many_pages)} ${s.upgrade_pages}` : fill(s.error_too_many_pages),
    error_limit: free ? s.upgrade_more : s.error_limit,
  };
  const planUrl = `/${lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`;
  const edit = rows.find((r) => r.id === editId) ?? null;
  const replace = rows.find((r) => r.id === replaceId) ?? null;
  const ownerRow = (row: Row): OwnerSectionRow => {
    const st = state(row, data);
    const text =
      st.key === "error"
        ? t(s.state_error, { reason: errorReason(dict, row.upload_error ?? "") })
        : st.date
          ? t((s as Record<string, string>)[`state_${st.key}`], { date: dateText(st.date, lang) })
          : fill((s as Record<string, string>)[`state_${st.key}`]);
    const details = [
      (s as Record<string, string>)[`display_${row.display}`],
      row.page_layout === "stacked" ? s.layout_stacked : s.layout_slider,
      row.pages ? t(s.pages, { n: row.pages }) : null,
      row.allow_download ? s.download_on : null,
      row.upload_version && row.version > 0 && !row.upload_error ? s.state_processing : null,
    ].filter(Boolean);
    return {
      id: row.id,
      title: row.title,
      state: text,
      details: details.join(" · "),
      hasPdf: row.version > 0,
      published: row.published,
      hidden: row.hidden,
    };
  };
  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";

  return (
    <div className="flex flex-col gap-5" data-owner-sections>
      {notice}
      <p className="text-sm text-muted">{s.intro}</p>
      {!limits && <p className="border border-line p-3 text-sm">{s.pro_only}</p>}
      {free && data.overLimit.size > 0 && <p className="border border-line p-3 text-sm" data-sections-downgraded>{s.plan_ended}</p>}
      {free && <p className="text-sm text-muted" data-free-position>{s.free_position}</p>}

      {rows.length > 0 && (
        <div className="flex flex-col gap-4">
          {POSITIONS.map((position) => {
            const here = rows.filter((r) => r.position === position);
            if (here.length === 0) return null;
            return (
              <SectionOrder
                key={position}
                shop={{ id: shop.id, slug: shop.slug, lang }}
                position={position}
                heading={(s as Record<string, string>)[`position_${position}`]}
                rows={here.map(ownerRow)}
                labels={s}
              />
            );
          })}
        </div>
      )}

      {edit && (
        <form action={updateSection} className="flex flex-col gap-3 border border-foreground p-3" id="section-edit" data-section-edit-form>
          {hidden({ at: "sections", section_id: edit.id })}
          <h3 className="font-semibold">{t(s.edit_title, { title: edit.title })}</h3>
          <label className="flex flex-col gap-1">
            <span className="text-sm">{s.field_title}</span>
            <input name="title" required maxLength={80} defaultValue={edit.title} className={input} />
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm">{s.display}</legend>
            {(["collapsed", "open"] as const).map((d) => (
              <label key={d} className="flex items-center gap-2">
                <input type="radio" name="display" value={d} defaultChecked={edit.display === d} />
                {s[`display_${d}`]}
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm">{s.page_layout}</legend>
            {(["slider", "stacked"] as const).map((l) => (
              <label key={l} className="flex items-center gap-2">
                <input type="radio" name="page_layout" value={l} defaultChecked={(edit.page_layout ?? "slider") === l} />
                {s[`layout_${l}`]}
              </label>
            ))}
            <span className="text-sm text-muted">{s.layout_hint}</span>
          </fieldset>
          {free ? (
            <input type="hidden" name="position" value={edit.position} />
          ) : (
            <label className="flex flex-col gap-1">
              <span className="text-sm">{s.position}</span>
              <select name="position" defaultValue={edit.position} className={input}>
                {POSITIONS.map((p) => (
                  <option key={p} value={p}>
                    {(s as Record<string, string>)[`position_${p}`]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" name="allow_download" defaultChecked={edit.allow_download} />
            {s.allow_download}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-sm">{s.visible_from}</span>
              <input type="date" name="from" defaultValue={edit.visible_from ?? ""} className={input} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm">{s.visible_until}</span>
              <input type="date" name="until" defaultValue={edit.visible_until ?? ""} className={input} />
            </label>
          </div>
          <div className="flex items-center gap-4">
            <PendingButton pending={dict.owner.saving}>{s.save}</PendingButton>
            <a href={`/${lang}/dashboard?${new URLSearchParams({ shop: shop.slug, at: "sections" })}#sections`} className="underline underline-offset-4">
              {s.cancel}
            </a>
          </div>
        </form>
      )}

      {replace && limits && (
        <div className="flex flex-col gap-2 border border-foreground p-3" id="section-replace">
          <h3 className="font-semibold">{t(s.replace_title, { title: replace.title })}</h3>
          <p className="text-sm text-muted">{s.replace_hint}</p>
          <SectionUploader mode="replace" shopId={shop.id} sectionId={replace.id} labels={uploaderLabels} limits={limits} />
        </div>
      )}

      {limits &&
        (rows.length < limits.maxSections ? (
          <div className="flex flex-col gap-2" id="section-add">
            <h3 className="font-semibold">{s.add}</h3>
            <SectionUploader mode="new" shopId={shop.id} labels={uploaderLabels} limits={limits} />
          </div>
        ) : free ? (
          // The free number is reached: no error, the way to more.
          <p data-sections-upgrade>
            <a href={planUrl} className="underline underline-offset-4">
              {s.upgrade_more}
            </a>
          </p>
        ) : (
          <p className="text-sm text-muted" data-sections-limit>
            {fill(s.limit_reached)}
          </p>
        ))}
    </div>
  );
}

/** The header picture of the shop's own domain (database update 28). */
export interface HeaderData {
  url: string | null;
  allowed: boolean;
}

export async function loadHeader(supabase: Supabase, shop: MyShop): Promise<HeaderData | null> {
  const [{ data, error }, alone] = await Promise.all([
    supabase.from("shops").select("header_url").eq("id", shop.id).maybeSingle(),
    supabase.rpc("shop_stands_alone", { p_shop_id: shop.id }),
  ]);
  if (error) return null;
  return { url: (data as { header_url: string | null } | null)?.header_url ?? null, allowed: alone.data === true };
}

/** Môj obchod → "Obrázok v hlavičke webu". */
export function HeaderPicturePanel({
  data,
  dict,
  hidden,
  notice,
}: {
  data: HeaderData | null;
  dict: Dictionary;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  notice: React.ReactNode;
}) {
  const s = dict.sections;
  if (!data) return <p className="text-sm text-muted">{s.unavailable}</p>;
  return (
    <div className="flex flex-col gap-3" data-header-panel>
      {notice}
      <p className="text-sm text-muted">{s.header_intro}</p>
      {data.url && (
        // eslint-disable-next-line @next/next/no-img-element -- the shop's own picture from Supabase Storage
        <img src={data.url} alt="" className="h-auto max-h-48 w-full border border-line object-cover" data-header-current />
      )}
      {data.allowed ? (
        <form action={uploadHeaderPicture} className="flex flex-col gap-2">
          {hidden({ at: "header" })}
          <HeaderPictureInput label={data.url ? s.header_change : s.header_upload} busy={dict.owner.uploading} />
          <p className="text-sm text-muted">{s.header_hint}</p>
        </form>
      ) : (
        <p className="border border-line p-3 text-sm">{s.header_only_pro}</p>
      )}
      {data.url && (
        <form action={removeHeaderPicture}>
          {hidden({ at: "header" })}
          <button type="submit" className="underline underline-offset-4" data-header-remove>
            {s.header_remove}
          </button>
        </form>
      )}
    </div>
  );
}
