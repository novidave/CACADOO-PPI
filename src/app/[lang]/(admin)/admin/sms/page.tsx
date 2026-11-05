import type { Metadata } from "next";
import { SmsAdmin, type SmsQuotaRow } from "../_parts/SmsAdmin";
import { AdminHead, AdminNotice, adminStart, adminTitle, Hidden } from "../_parts/common";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/sms">): Promise<Metadata> {
  return adminTitle(params, "sms");
}

/**
 * Admin → SMS (2026-11-05; database update 58): every shop's monthly SMS quotas (admin_save_sms_quotas /
 * admin_save_sms_quota) and which provider the crm-messages function sends with.
 */
export default async function AdminSmsPage({ params, searchParams }: PageProps<"/[lang]/admin/sms">) {
  const { lang, dict, session } = await adminStart(params);
  const sp = await searchParams;
  const [smsQuotas, smsProvider] = await Promise.all([
    session.supabase.rpc("admin_sms_quotas"),
    session.supabase.functions
      .invoke<{ sms?: string; sms_live?: boolean }>("crm-messages", { body: { action: "config" } })
      .then(({ data, error }) => (error || !data?.sms ? null : { name: data.sms, live: data.sms_live === true }))
      .catch(() => null),
  ]);
  const hidden = <Hidden lang={lang} keep="" />;
  return (
    <div className="flex flex-col gap-8">
      <div>
        <AdminHead dict={dict} page="sms" />
        <AdminNotice dict={dict} sp={sp} />
      </div>
      <SmsAdmin rows={smsQuotas.error ? null : ((smsQuotas.data ?? []) as SmsQuotaRow[])} provider={smsProvider} dict={dict} hidden={hidden} />
    </div>
  );
}
