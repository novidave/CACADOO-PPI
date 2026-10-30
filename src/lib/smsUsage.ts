import type { SupabaseClient } from "@supabase/supabase-js";

/** One monthly SMS quota of a shop (database update 58): SMS parts used this month and the limit. */
export interface SmsQuota {
  used: number;
  limit: number;
}

/** Both quotas of a shop this month: the booking's codes and reminders, and the owner's own SMS. */
export interface SmsUsage {
  booking: SmsQuota;
  owner: SmsQuota;
  month_start: string;
  resets_at: string;
}

export const quotaLeft = (q: SmsQuota) => Math.max(q.limit - q.used, 0);

/** owner_sms_usage() for a member of the shop; null before update 58 or when it cannot be read. */
export async function loadSmsUsage(supabase: SupabaseClient, shopId: string): Promise<SmsUsage | null> {
  const { data, error } = await supabase.rpc("owner_sms_usage", { p_shop_id: shopId });
  if (error || !data) return null;
  const u = data as SmsUsage;
  return typeof u.booking?.limit === "number" && typeof u.owner?.limit === "number" ? u : null;
}
