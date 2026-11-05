import type { Metadata } from "next";
import { type PartnerEnv, PartnerFeedsAdmin, type PartnerSettings } from "../_parts/PartnerFeedsAdmin";
import { AdminHead, AdminNotice, adminStart, adminTitle, Hidden } from "../_parts/common";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/partners">): Promise<Metadata> {
  return adminTitle(params, "partners");
}

/**
 * Admin → Partnerské feedy (2026-11-05; database update 35): the partners, their feeds, stores and imports
 * (admin_partner_settings) and the partner-feeds function's size limit.
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
    <div className="flex flex-col gap-8">
      <div>
        <AdminHead dict={dict} page="partners" />
        <AdminNotice dict={dict} sp={sp} />
      </div>
      <PartnerFeedsAdmin
        settings={partnerSettings.error ? null : (partnerSettings.data as PartnerSettings)}
        env={partnerEnv}
        lang={lang}
        dict={dict}
        hidden={hidden}
      />
    </div>
  );
}
