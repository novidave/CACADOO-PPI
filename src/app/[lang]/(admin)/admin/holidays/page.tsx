import type { Metadata } from "next";
import { type AdminHoliday, HolidaysAdmin } from "../_parts/HolidaysAdmin";
import { AdminHead, AdminNotice, adminStart, adminTitle, Hidden, first, keepOf } from "../_parts/common";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/holidays">): Promise<Metadata> {
  return adminTitle(params, "holidays");
}

/**
 * Admin → Sviatky (2026-11-05; database update 27): one country and year at a time (default: Slovakia, this year),
 * the library's rows and the admin's (admin_holidays, admin_save_holiday, admin_delete_holiday — is_admin() each).
 */
export default async function AdminHolidaysPage({ params, searchParams }: PageProps<"/[lang]/admin/holidays">) {
  const { lang, dict, session } = await adminStart(params);
  const sp = await searchParams;
  // "Sviatky": one country and year at a time (default: Slovakia, this year).
  const hcountry = /^[A-Za-z]{2}$/.test(first(sp.hcountry) ?? "") ? first(sp.hcountry)!.toUpperCase() : "SK";
  const hyearValue = Number(first(sp.hyear));
  const hyear = Number.isInteger(hyearValue) && hyearValue >= 2000 && hyearValue < 2100 ? hyearValue : new Date().getUTCFullYear();
  const keep = keepOf({ hcountry, hyear });
  const holidays = await session.supabase.rpc("admin_holidays", { p_country: hcountry, p_year: hyear });
  const hidden = <Hidden lang={lang} keep={keep} />;
  return (
    <div className="flex flex-col gap-8">
      <div>
        <AdminHead dict={dict} page="holidays" />
        <AdminNotice dict={dict} sp={sp} />
      </div>
      <HolidaysAdmin
        rows={holidays.error ? null : ((holidays.data ?? []) as AdminHoliday[])}
        country={hcountry}
        year={hyear}
        lang={lang}
        dict={dict}
        hidden={hidden}
        keep={keep}
      />
    </div>
  );
}
