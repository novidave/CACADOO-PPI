import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { localDateTime } from "@/lib/hours";
import { missingColumn } from "@/lib/missingColumn";
import type { MyShop } from "@/lib/myShops";
import { megabytes, POSITIONS, PRO_BEFORE_30, type SectionLimits, type SectionPosition } from "@/lib/sections";
import { PendingButton } from "@/components/PendingButton";
import { SectionOrder, type OwnerSectionRow } from "@/components/SectionOrder";
import { SectionUploader } from "@/components/SectionUploader";
import { SiteLogoInput } from "@/components/SiteLogoInput";
import { removeSiteLogo, resetSiteLogoLink, saveSiteLogoLink, updateSection, uploadSiteLogo } from "./sectionActions";
import { inputClass } from "./shared";
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
  /** A PDF or pictures (database update 31; a PDF before it). */
  source?: "pdf" | "pictures";
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
    read(`${columns}, page_layout, source`),
    supabase.rpc("owner_section_limits", { p_shop_id: shop.id }),
  ]);
  let { data, error } = first;
  // Before database updates 31 / 29 the newer columns are not there yet.
  if (missingColumn(error, "source")) ({ data, error } = await read(`${columns}, page_layout`));
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
    error_too_many_pictures: free ? `${fill(s.error_too_many_pictures)} ${s.upgrade_pages}` : fill(s.error_too_many_pictures),
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
      row.source === "pictures" ? s.source_pictures : null,
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

/** The header logo of the shop's own domain (database update 31; null before it). */
export interface SiteLogoData {
  url: string | null;
  /** The shop's own logo: what the header shows without a header logo. */
  shopLogo: string | null;
  allowed: boolean;
  /**
   * "Odkaz loga" (database update 32): where the logo leads; null = the home page. undefined
   * before update 32 (no such choice yet: the field is not shown).
   */
  link?: string | null;
}

export async function loadSiteLogo(supabase: Supabase, shop: MyShop): Promise<SiteLogoData | null> {
  const read = (columns: string) => supabase.from("shops").select(columns).eq("id", shop.id).maybeSingle();
  const [first, alone] = await Promise.all([read("site_logo_url, logo_url, site_logo_link"), supabase.rpc("shop_stands_alone", { p_shop_id: shop.id })]);
  const { data, error } = missingColumn(first.error, "site_logo_link") ? await read("site_logo_url, logo_url") : first;
  if (error) return null;
  const row = data as unknown as { site_logo_url: string | null; logo_url: string | null; site_logo_link?: string | null } | null;
  return {
    url: row?.site_logo_url ?? null,
    shopLogo: row?.logo_url ?? null,
    allowed: alone.data === true,
    link: row && "site_logo_link" in row ? (row.site_logo_link ?? null) : undefined,
  };
}

/** The address without https:// and a lone trailing slash, as a person reads it. */
export const shortLink = (link: string) => link.replace(/^https:\/\//i, "").replace(/^([^/?#]+)\/$/, "$1");

/** The closed section's line: the logo, and where it leads when not to the home page. */
export function siteLogoSummary(data: SiteLogoData | null, dict: Dictionary): string {
  const s = dict.sections;
  if (!data) return s.unavailable;
  const logo = data.url ? s.site_logo_set : data.allowed ? s.site_logo_none : s.site_logo_only_pro;
  return data.link ? `${logo} · ${t(s.site_logo_link_summary, { link: shortLink(data.link) })}` : logo;
}

/**
 * Môj obchod → "Logo v hlavičke webu" (Pro or a domain of its own): the small logo at the top
 * left of the shop's own domain, a link to its home page or to the address in "Odkaz loga"
 * (database update 32); without a header logo the shop's logo is used.
 */
export function SiteLogoPanel({
  data,
  shopName,
  dict,
  hidden,
  notice,
}: {
  data: SiteLogoData | null;
  shopName: string;
  dict: Dictionary;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  notice: React.ReactNode;
}) {
  const s = dict.sections;
  if (!data) return <p className="text-sm text-muted">{s.unavailable}</p>;
  const shown = data.url ?? data.shopLogo;
  return (
    <div className="flex flex-col gap-3" data-site-logo-panel>
      {notice}
      <p className="text-sm text-muted">{s.site_logo_intro}</p>
      {/* As in the header: 40 px high on a white bar with a thin line under it. */}
      <div className="flex items-center justify-between gap-3 border border-line px-3 py-2" data-site-logo-preview>
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element -- the shop's own logo from Supabase Storage
          <img src={shown} alt={shopName} className="h-10 w-auto max-w-[200px] object-contain" data-site-logo-current={data.url ? "own" : "shop"} />
        ) : (
          <span className="font-semibold">{shopName}</span>
        )}
        <span className="text-sm text-muted">SK · HU · EN</span>
      </div>
      <p className="text-sm text-muted">{data.url ? s.site_logo_set : s.site_logo_none}</p>
      {data.allowed ? (
        <form action={uploadSiteLogo} className="flex flex-col gap-2">
          {hidden({ at: "header" })}
          <SiteLogoInput label={data.url ? s.site_logo_change : s.site_logo_upload} busy={dict.owner.uploading} />
          <p className="text-sm text-muted" data-site-logo-hint>
            {s.site_logo_hint}
          </p>
        </form>
      ) : (
        <p className="border border-line p-3 text-sm">{s.site_logo_only_pro}</p>
      )}
      {data.url && (
        <form action={removeSiteLogo}>
          {hidden({ at: "header" })}
          <button type="submit" className="underline underline-offset-4" data-site-logo-remove>
            {s.site_logo_remove}
          </button>
        </form>
      )}
      {data.link !== undefined && (data.allowed || data.link) && (
        <div className="flex flex-col gap-2 border-t border-line pt-3" data-site-logo-link-panel>
          <p className="text-sm" data-site-logo-link-current>
            {data.link ? (
              <>
                {s.site_logo_link_to}{" "}
                <a href={data.link} target="_blank" rel="noopener" className="break-all font-semibold underline underline-offset-4">
                  {shortLink(data.link)}
                </a>
              </>
            ) : (
              s.site_logo_link_home
            )}
          </p>
          {data.allowed && (
            <form action={saveSiteLogoLink} className="flex flex-col gap-2" data-site-logo-link-form>
              {hidden({ at: "header" })}
              <label className="flex flex-col gap-1">
                <span className="text-sm">{s.site_logo_link_label}</span>
                <input
                  name="site_logo_link"
                  type="text"
                  inputMode="url"
                  autoComplete="url"
                  maxLength={500}
                  placeholder="https://"
                  defaultValue={data.link ?? ""}
                  className={inputClass}
                  aria-describedby="site-logo-link-hint"
                />
              </label>
              <p id="site-logo-link-hint" className="text-sm text-muted" data-site-logo-link-hint>
                {s.site_logo_link_hint}
              </p>
              <div>
                <PendingButton pending={dict.owner.saving}>{s.site_logo_link_save}</PendingButton>
              </div>
            </form>
          )}
          {data.link && (
            <form action={resetSiteLogoLink}>
              {hidden({ at: "header" })}
              <button type="submit" className="underline underline-offset-4" data-site-logo-link-reset>
                {s.site_logo_link_reset}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
