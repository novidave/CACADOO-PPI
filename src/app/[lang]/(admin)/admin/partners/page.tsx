import type { Metadata } from "next";
import Link from "next/link";
import { adminHref } from "@/lib/adminPages";
import { ghostClass } from "@/components/owner/ui";
import { type PartnerEnv, PartnerFeedsAdmin, type PartnerSettings } from "../_parts/PartnerFeedsAdmin";
import { AdminHead, AdminNotice, adminStart, adminTitle, first, Hidden } from "../_parts/common";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/partners">): Promise<Metadata> {
  return adminTitle(params, "partners");
}

/**
 * Admin → Partnerské feedy (2026-11-05; database update 35): the partners, their feeds, stores and imports
 * (admin_partner_settings) and the partner-feeds function's size limit; "+ Pridať partnera" (?add=1) opens the form.
 */
export default async function AdminPartnersPage({ params, searchParams }: PageProps<"/[lang]/admin/partners">) {
  const { lang, dict, session } = await adminStart(params);
  const sp = await searchParams;
  const [partnerSettings, partnerEnv] = await Promise.all([
    session.supabase.rpc("admin_partner_settings"),
    session.supabase.functions
      .invoke<{ env: PartnerEnv }>("partner-feeds", { body: { action: "admin_status" } })
      .then(({ data, error }) => (error || !data ? null : data.env))
      .catch(() => null),
  ]);
  const hidden = <Hidden lang={lang} keep="" />;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <AdminHead
          dict={dict}
          page="partners"
          aside={
            <Link href={adminHref(lang, "partners", { add: "1" }, "partner-new")} className={`${ghostClass} !min-h-11 !px-4 !text-[15px] no-underline`} data-partner-add>
              {dict.admin_partners.add_button}
            </Link>
          }
        />
        <AdminNotice dict={dict} sp={sp} />
      </div>
      <PartnerFeedsAdmin
        settings={partnerSettings.error ? null : (partnerSettings.data as PartnerSettings)}
        env={partnerEnv}
        adding={first(sp.add) === "1"}
        lang={lang}
        dict={dict}
        hidden={hidden}
      />
    </div>
  );
}
