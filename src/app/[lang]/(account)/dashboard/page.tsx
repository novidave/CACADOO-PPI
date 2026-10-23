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
import { deleteShop, saveShop, uploadLogo } from "./actions";
import { errorText, hiddenFields, messages, SubmitButton } from "./shared";
import { Holidays, holidaysSummary, loadHolidays } from "./Holidays";
import { loadSiteLogo, siteLogoSummary, SiteLogoPanel } from "./SiteLogoPanel";

/** The shop's row in subscriptions (written only by the Stripe functions). */
interface PlanRow {
  status: string;
  plan: string | null;
  current_period_end: string | null;
  cancel_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The shop owner's own area (self-service): create shops, edit details, holidays and logo, the plan, delete the
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
          <h1 className="text-2xl font-semibold tracking-tight">{o.create_title}</h1>
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
  const [planRow, hasPlan, holidays, header, stockState] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("status, plan, current_period_end, cancel_at, stripe_customer_id, stripe_subscription_id")
      .eq("shop_id", shop.id)
      .maybeSingle(),
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    // "Sviatky a mimoriadne zatvorenie" (database update 27; null before it).
    loadHolidays(supabase, shop),
    // "Logo v hlavičke webu" (database update 31; null before it).
    loadSiteLogo(supabase, shop),
    // After "Vymazať celý sklad" (database update 43): ask for a new stock file until one is applied.
    supabase.rpc("owner_inventory_state", { p_shop_id: shop.id }),
  ]);
  const needsFile = !stockState.error && (stockState.data as { needs_file?: boolean } | null)?.needs_file === true;
  // The database decides whether the shop has the paid plan; before database update 18
  // the Plan section only says that paid plans are not available yet.
  const plan = planRow.error || hasPlan.error ? null : { row: planRow.data as PlanRow | null, active: hasPlan.data === true };
  const hidden = hiddenFields(lang, shop);
  const m = messages(dict, sp);
  const { at, okText, notice, section } = m;

  // One line per section while it is closed.
  const summaries = {
    details: addressLine(shop.address, shop.city) || shop.name,
    holidays: holidaysSummary(holidays, dict),
    logo: shop.logo_url ? d.summary_logo : d.summary_no_logo,
    header: siteLogoSummary(header, dict),
    plan: plan ? (plan.active ? dict.plan.pro : dict.plan.free) : dict.plan.unavailable,
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <nav className="flex flex-wrap gap-3 text-sm" aria-label={d.shop}>
          {shops.length > 1 &&
            shops.map((s) => (
              <Link
                key={s.id}
                href={`/${lang}/dashboard?shop=${s.slug}`}
                className={s.id === shop.id ? "font-semibold underline underline-offset-4" : "text-muted hover:underline"}
              >
                {s.name}
              </Link>
            ))}
          <Link href={`/${lang}/dashboard?new=1`} className="text-muted hover:underline">
            {o.add_shop}
          </Link>
        </nav>
        <h1 className="text-2xl font-semibold tracking-tight">{shop.name}</h1>
        {shop.is_active && (
          <Link href={`/${lang}/shops/${shop.slug}`} className="text-sm underline underline-offset-4">
            {d.view_public}
          </Link>
        )}
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

      <div className="flex flex-col border-t border-line">
        <DashboardSection {...section("details")} title={d.details_title} summary={summaries.details}>
          {notice("details")}
          <ShopForm
            dict={dict}
            lang={lang}
            shop={shop}
            defaults={{ country: "", timezone: "" }}
            action={saveShop}
            submitLabel={dict.account.save}
          />
        </DashboardSection>

        <DashboardSection {...section("holidays")} title={dict.holidays.title} summary={summaries.holidays}>
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

        <DashboardSection {...section("plan")} title={dict.domains.title} summary={summaries.plan}>
          {notice("plan")}
          <p className="text-sm">{plan ? (plan.active ? dict.plan.pro : dict.plan.free) : dict.plan.unavailable}</p>
          <Link href={`/${lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`} className="self-start rounded border border-foreground px-4 py-2 font-medium" data-plan-page>
            {dict.domains.open_page}
          </Link>
        </DashboardSection>

        <DashboardSection {...section("delete")} title={o.delete_title} summary={o.delete_summary}>
          <form action={deleteShop} className="flex flex-col gap-3">
            {hidden({ at: "delete" })}
            {notice("delete")}
            <p className="text-sm">{o.delete_intro}</p>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="confirm" required />
              {o.delete_confirm}
            </label>
            <SubmitButton pending={o.saving}>{o.delete_button}</SubmitButton>
          </form>
        </DashboardSection>
      </div>
    </div>
  );
}
