"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { sectionUrl } from "@/lib/dashboardPages";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Vybavené" / "Vrátiť medzi čakajúce" for a shopper who left a contact (database update 59): owner_callback_done
 * checks the membership itself; back to where the owner was (the conversation or the Konverzácie tab).
 */
export async function markCallback(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const id = String(formData.get("conversation_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  if (UUID.test(id)) {
    await session.supabase.rpc("owner_callback_done", { p_conversation_id: id, p_done: formData.get("done") === "1" });
  }
  if (formData.get("from") === "conversation" && UUID.test(id)) redirect(`/${lang}/dashboard/conversations/${id}`);
  redirect(sectionUrl(lang, "conversations", { shop: slug }));
}
