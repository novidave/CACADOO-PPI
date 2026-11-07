import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { requireUser } from "@/lib/auth";
import { conversationHref } from "@/lib/dashboardPages";
import type { MyShop } from "@/lib/myShops";

export const metadata: Metadata = { robots: { index: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The old address of one conversation (e-mails, Telegram and saved links still use it): since 2026-11-07 a conversation
 * is open in CRM → Konverzácie (`/dashboard/crm?shop=<slug>&c=<id>`, the two-pane inbox). Its shop comes from the
 * conversation itself (RLS: only the shop's members read it); its query goes along (`#reply` stays in the browser).
 */
export default async function ConversationForward({ params, searchParams }: PageProps<"/[lang]/dashboard/conversations/[id]">) {
  const { lang, id } = await params;
  if (!isLocale(lang) || !UUID.test(id)) notFound();
  const { supabase } = await requireUser(lang);
  const sp = await searchParams;
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const one = Array.isArray(v) ? v[0] : v;
    if (typeof one === "string" && k !== "c" && k !== "shop") query[k] = one.slice(0, 200);
  }
  const [{ data: conv }, { data: shopRows }] = await Promise.all([
    supabase.from("assistant_conversations").select("shop_id").eq("id", id).maybeSingle(),
    supabase.rpc("my_shops"),
  ]);
  const shops = (shopRows ?? []) as MyShop[];
  const shop = shops.find((s) => s.id === conv?.shop_id) ?? shops[0];
  if (!shop) redirect(`/${lang}/dashboard`);
  // not one of the owner's conversations: the inbox says "not found" in its pane
  redirect(conversationHref(lang, shop.slug, id, query));
}
