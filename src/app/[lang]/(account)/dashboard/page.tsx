import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { forwardUrl, movedFrom, sectionUrl } from "@/lib/dashboardPages";
import { addressLine } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { DashboardSection } from "@/components/DashboardSection";
import { DbError } from "@/components/DbError";
import { LogoInput } from "@/components/LogoInput";
import { ShopForm } from "@/components/ShopForm";
import { ghostClass } from "@/components/owner/ui";
import { deleteShop, saveShop, uploadLogo } from "./actions";
import { errorText, hiddenFields, messages, SubmitButton } from "./shared";
import { Holidays, holidaysSummary, loadHolidays } from "./Holidays";
import { loadSiteLogo, siteLogoSummary, SiteLogoPanel } from "./SiteLogoPanel";
import { PageTitle } from "@/components/owner/PageHead";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The shop owner's own area (self-service): create shops, edit details, holidays and logo, delete the
 * shop. The stock file's columns and the items are on "Jazyky a inventár" (/dashboard/translations). The
 * assistant has its own page ("AI asistent", /dashboard/assistant) and so has the export
 * folder ("Priečinok s exportom", /sync). Every main section is a dropdown with a summary
 * line. Nothing here changes the uploaded stock or how it is shown: that comes only from the file.
 */
export default async function DashboardPage({ params, searchParams }: PageProps<"/[lang]/dashboard">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const sp = await searchParams;
  // A section that moved to "Asistent", "Obsah stránky" or "Priečinok s exportom" (old links, e-mails, the cloud
  // sign-in coming back with ?at=cloud, "Sekcie stránky (PDF)" → "Obsah stránky"): the same address on its new page.
  const atParam = first(sp.at) ?? "";
  if (movedFrom("dashboard", atParam)) redirect(forwardUrl(lang, atParam, sp));
  const ok = first(sp.ok);
  const err = first(sp.err);
  const o = dict.owner;
  const d = dict.dashboard;

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];

  // No shop yet (or "+ Add another shop"): the create form.
  if (shops.length === 0 || first(sp.new) === "1") {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          {shops.length > 0 && (
            <Link href={`/${lang}/dashboard`} className="text-sm underline underline-offset-4">
              ← {dict.account.dashboard}
            </Link>
          )}
          <PageTitle>{o.create_title}</PageTitle>
          <p className="text-muted">{o.create_intro}</p>
          {ok === "deleted" && <p className="border border-foreground p-3 font-medium">{o.deleted}</p>}
          {err && <p className="border border-line p-3">{errorText(dict, err)}</p>}
        </header>
        <ShopForm
          dict={dict}
          lang={lang}
          shop={null}
          defaults={{ country: "", timezone: "" }}
          action={saveShop}
          submitLabel={o.create_button}
        />
      </div>
    );
  }

  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];
  // back-end layout L3: the plan box moved to "Predplatné a doména" (/dashboard/plan)
  const [holidays, header, stockState] = await Promise.all([
    // "Sviatky a mimoriadne zatvorenie" (database update 27; null before it).
    loadHolidays(supabase, shop),
    // "Logo v hlavičke webu" (database update 31; null before it).
    loadSiteLogo(supabase, shop),
    // After "Vymazať celý sklad" (database update 43): ask for a new stock file until one is applied.
    supabase.rpc("owner_inventory_state", { p_shop_id: shop.id }),
  ]);
  const needsFile = !stockState.error && (stockState.data as { needs_file?: boolean } | null)?.needs_file === true;
  const hidden = hiddenFields(lang, shop);
  const m = messages(dict, sp);
  const { at, okText, notice, section } = m;

  // One line per section while it is closed.
  const summaries = {
    details: addressLine(shop.address, shop.city) || shop.name,
    holidays: holidaysSummary(holidays, dict),
    logo: shop.logo_url ? d.summary_logo : d.summary_no_logo,
    header: siteLogoSummary(header, dict),
  };

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      {/* artboard 9: "Môj obchod" + the shop's name; the shop switcher and "+ Pridať obchod" are the menu's */}
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PageTitle>{dict.nav.shop}</PageTitle>
          <a href="#holidays" className={ghostClass} data-holidays-link>
            {dict.holidays.title}
          </a>
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px]">
          <strong>{shop.name}</strong>
          {shop.is_active && (
            <Link href={`/${lang}/shops/${shop.slug}`} className="underline underline-offset-4">
              {d.view_public}
            </Link>
          )}
        </p>
        {needsFile && (
          <div className="flex flex-col gap-1 border border-foreground p-3" data-needs-file>
            <p className="font-semibold">{dict.reset.upload_new_title}</p>
            <p className="text-sm">{dict.reset.upload_new_text}</p>
            <Link href={sectionUrl(lang, "export", { shop: shop.slug })} className="self-start text-sm underline underline-offset-4">
              {dict.reset.upload_new_link}
            </Link>
          </div>
        )}
        {ok === "created" ? (
          <div className="flex flex-col gap-2 border border-foreground p-3">
            <p className="font-semibold">{o.created}</p>
            <ol className="list-decimal pl-6 text-sm">
              <li>
                <Link href={`/${lang}/sync?${new URLSearchParams({ shop: shop.slug })}`} className="underline underline-offset-4">
                  {o.step_folder}
                </Link>
              </li>
              <li>
                <Link href={`/${lang}/dashboard/translations?${new URLSearchParams({ shop: shop.slug, at: "columns" })}#columns`} className="underline underline-offset-4">
                  {o.step_columns}
                </Link>
              </li>
              <li>{o.step_visible}</li>
            </ol>
          </div>
        ) : (
          ok && !at && <p className="border border-foreground p-3 font-medium">{okText}</p>
        )}
        {err && !at && <p className="border border-line p-3">{errorText(dict, err)}</p>}
      </header>

      <div className="flex flex-col gap-3">
        <DashboardSection {...section("details")} title={d.details_title} summary={summaries.details}>
          {notice("details")}
          <ShopForm
            dict={dict}
            lang={lang}
            shop={shop}
            defaults={{ country: "", timezone: "" }}
            action={saveShop}
            submitLabel={dict.account.save}
            companyElsewhere={{
              href: `/${lang}/dashboard/legal?${new URLSearchParams({ shop: shop.slug })}#company`,
              label: dict.shop_legal.admin_title,
              hint: dict.shop_legal.company_moved,
            }}
          />
        </DashboardSection>

        <DashboardSection {...section("holidays")} title={dict.holidays.title} summary={summaries.holidays}>
          <p className="text-sm">
            {dict.hours_sms.dashboard_link}{" "}
            <Link href={`/${lang}/dashboard/hours-sms?shop=${shop.slug}`} className="underline underline-offset-4" data-hours-sms-link>
              {dict.account.hours_sms_page}
            </Link>
          </p>
          <Holidays
            data={holidays}
            shop={shop}
            lang={lang}
            dict={dict}
            hidden={hidden}
            notice={notice("holidays")}
            editDate={/^\d{4}-\d{2}-\d{2}$/.test(first(sp.date) ?? "") ? first(sp.date)! : null}
          />
        </DashboardSection>

        <DashboardSection {...section("logo")} title={d.logo_title} summary={summaries.logo}>
          <form action={uploadLogo} className="flex flex-col gap-3">
            {hidden({ at: "logo" })}
            {notice("logo")}
            {shop.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element -- logo from Supabase Storage
              <img src={shop.logo_url} alt="" width={64} height={64} className="h-16 w-16 border border-line object-contain" />
            )}
            <LogoInput label={d.upload} busy={o.uploading} />
            <p className="text-sm text-muted">{d.logo_hint}</p>
          </form>
        </DashboardSection>

        <DashboardSection {...section("header")} title={dict.sections.site_logo_title} summary={summaries.header}>
          <SiteLogoPanel data={header} shopName={shop.name} dict={dict} hidden={hidden} notice={notice("header")} />
        </DashboardSection>

        <DashboardSection {...section("delete")} title={o.delete_title} summary={o.delete_summary}>
          <form action={deleteShop} className="flex flex-col gap-3">
            {hidden({ at: "delete" })}
            {notice("delete")}
            <p className="text-sm">{o.delete_intro}</p>
            <label className="flex min-h-11 items-center gap-3">
              <input type="checkbox" name="confirm" required className="h-6 w-6 flex-none accent-[#111]" />
              {o.delete_confirm}
            </label>
            <SubmitButton pending={o.saving}>{o.delete_button}</SubmitButton>
          </form>
        </DashboardSection>
      </div>
    </div>
  );
}
