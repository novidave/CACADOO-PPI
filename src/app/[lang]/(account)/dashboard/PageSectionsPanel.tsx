import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { localDateTime } from "@/lib/hours";
import { missingColumn } from "@/lib/missingColumn";
import type { MyShop } from "@/lib/myShops";
import { MAX_SECTIONS, POSITIONS, type SectionPosition } from "@/lib/sections";
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
  /** "Zobrazenie strán" (database update 29; "slider" before it). */
  page_layout?: "slider" | "stacked";
}

export interface SectionsData {
  rows: Row[];
  plan: boolean;
  today: string;
}

/** The shop's page sections (database update 28; null before it). */
export async function loadSections(supabase: Supabase, shop: MyShop, plan: boolean): Promise<SectionsData | null> {
  const columns =
    "id, title, display, position, sort, allow_download, visible_from, visible_until, hidden, published, version, pages, upload_version, upload_error, updated_at";
  const read = (cols: string) => supabase.from("shop_page_sections").select(cols).eq("shop_id", shop.id).order("sort").order("created_at");
  let { data, error } = await read(`${columns}, page_layout`);
  if (missingColumn(error, "page_layout")) ({ data, error } = await read(columns));
  if (error) return null;
  return { rows: (data ?? []) as unknown as Row[], plan, today: localDateTime(new Date(), shop.timezone).date };
}

export function sectionsSummary(data: SectionsData | null, dict: Dictionary): string {
  const s = dict.sections;
  if (!data) return s.unavailable;
  if (data.rows.length === 0) return data.plan ? s.summary_none : s.pro_only;
  return t(s.summary, { n: data.rows.length, shown: data.rows.filter((r) => state(r, data).key === "live").length });
}

/** What the owner reads next to a section (the database decides the same for visitors). */
function state(row: Row, data: SectionsData): { key: string; date?: string } {
  if (row.upload_error) return { key: "error" };
  if (row.version === 0) return { key: row.upload_version ? "processing" : "empty" };
  if (!row.published) return { key: "draft" };
  if (row.hidden) return { key: "hidden" };
  if (!data.plan) return { key: "no_plan" };
  if (row.visible_from && row.visible_from > data.today) return { key: "before", date: row.visible_from };
  if (row.visible_until && row.visible_until < data.today) return { key: "after", date: row.visible_until };
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
  const edit = rows.find((r) => r.id === editId) ?? null;
  const replace = rows.find((r) => r.id === replaceId) ?? null;
  const ownerRow = (row: Row): OwnerSectionRow => {
    const st = state(row, data);
    const text =
      st.key === "error"
        ? t(s.state_error, { reason: errorReason(dict, row.upload_error ?? "") })
        : st.date
          ? t((s as Record<string, string>)[`state_${st.key}`], { date: dateText(st.date, lang) })
          : (s as Record<string, string>)[`state_${st.key}`];
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
      {!data.plan && <p className="border border-line p-3 text-sm">{rows.length ? s.plan_ended : s.pro_only}</p>}

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

      {replace && data.plan && (
        <div className="flex flex-col gap-2 border border-foreground p-3" id="section-replace">
          <h3 className="font-semibold">{t(s.replace_title, { title: replace.title })}</h3>
          <p className="text-sm text-muted">{s.replace_hint}</p>
          <SectionUploader mode="replace" shopId={shop.id} sectionId={replace.id} labels={s} />
        </div>
      )}

      {data.plan &&
        (rows.length < MAX_SECTIONS ? (
          <div className="flex flex-col gap-2" id="section-add">
            <h3 className="font-semibold">{s.add}</h3>
            <SectionUploader mode="new" shopId={shop.id} labels={s} />
          </div>
        ) : (
          <p className="text-sm text-muted">{s.limit_reached}</p>
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
