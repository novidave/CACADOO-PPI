import type { Metadata } from "next";
import { SmsAdmin, type SmsBusiestRow, type SmsProviderInfo, type SmsQuotaRow } from "../_parts/SmsAdmin";
import { AdminHead, AdminNotice, adminStart, adminTitle, Hidden } from "../_parts/common";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/sms">): Promise<Metadata> {
  return adminTitle(params, "sms");
}

/**
 * Admin → SMS (2026-11-05; database updates 58 and 83): every shop's monthly SMS quotas (admin_save_sms_quotas /
 * admin_save_sms_quota), this month's totals, the busiest shop of each quota (admin_sms_busiest) and which provider the
 * crm-messages function sends with, its sender and how SMS are received (crm-messages "config", 2026-11-05). Read at once; a read that fails leaves its part out, never an error page.
 */
export default async function AdminSmsPage({ params, searchParams }: PageProps<"/[lang]/admin/sms">) {
  const { lang, dict, session } = await adminStart(params);
  const sp = await searchParams;
  const [smsQuotas, busiest, smsProvider] = await Promise.all([
    session.supabase.rpc("admin_sms_quotas"),
    session.supabase.rpc("admin_sms_busiest"),
    session.supabase.functions
      .invoke<{ sms?: string; sms_live?: boolean; sms_sender?: string; sms_inbound?: string[]; sms_number?: boolean }>("crm-messages", {
        body: { action: "config" },
      })
      .then(({ data, error }): SmsProviderInfo | null =>
        error || !data?.sms
          ? null
          : {
              name: data.sms,
              live: data.sms_live === true,
              sender: typeof data.sms_sender === "string" ? data.sms_sender : null,
              inbound: Array.isArray(data.sms_inbound) ? data.sms_inbound.filter((w) => typeof w === "string") : null,
              number: typeof data.sms_number === "boolean" ? data.sms_number : null,
            },
      )
      .catch(() => null),
  ]);
  const hidden = <Hidden lang={lang} keep="" />;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <AdminHead dict={dict} page="sms" />
        <AdminNotice dict={dict} sp={sp} />
      </div>
      <SmsAdmin
        rows={smsQuotas.error ? null : ((smsQuotas.data ?? []) as SmsQuotaRow[])}
        busiest={busiest.error ? null : ((busiest.data ?? []) as SmsBusiestRow[])}
        provider={smsProvider}
        dict={dict}
        hidden={hidden}
      />
    </div>
  );
}
