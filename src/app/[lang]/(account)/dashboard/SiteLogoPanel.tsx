import { t, type Dictionary } from "@/i18n/dictionaries";
import { missingColumn } from "@/lib/missingColumn";
import type { MyShop } from "@/lib/myShops";
import { PendingButton } from "@/components/PendingButton";
import { SiteLogoInput } from "@/components/SiteLogoInput";
import { removeSiteLogo, resetSiteLogoLink, saveSiteLogoLink, uploadSiteLogo } from "./sectionActions";
import { inputClass } from "./shared";
import type { Supabase } from "./ShopDocuments";

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
