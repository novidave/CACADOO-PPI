import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { needsAttention, type AdminShop } from "@/lib/admin";
import { requireAdmin } from "@/lib/auth";
import { freshnessText } from "@/lib/stock";
import { DbError } from "@/components/DbError";

export default async function AdminPage({ params }: PageProps<"/[lang]/admin">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, { supabase }] = await Promise.all([getDictionary(lang), requireAdmin(lang)]);

  const { data, error } = await supabase.rpc("admin_shops");
  if (error) return <DbError message={error.message} dict={dict} />;
  const shops = ((data ?? []) as AdminShop[])
    .map((shop) => ({ shop, attention: needsAttention(shop) }))
    // Shops that need attention first.
    .sort((a, b) => Number(b.attention) - Number(a.attention));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{dict.admin.shops_title}</h1>
        <Link href={`/${lang}/admin/shops/new`} className="rounded border border-foreground px-4 py-2 font-medium">
          {dict.admin.new_shop}
        </Link>
      </div>

      {shops.length === 0 ? (
        <p>{dict.admin.no_shops}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="py-2 pr-3 font-normal">{dict.admin.col_name}</th>
                <th className="py-2 pr-3 font-normal">{dict.admin.col_city}</th>
                <th className="py-2 pr-3 font-normal">{dict.admin.col_active}</th>
                <th className="py-2 pr-3 text-right font-normal">{dict.admin.col_items}</th>
                <th className="py-2 pr-3 font-normal">{dict.admin.col_fresh}</th>
                <th className="py-2 font-normal">{dict.admin.col_error}</th>
              </tr>
            </thead>
            <tbody>
              {shops.map(({ shop, attention }) => (
                <tr key={shop.id} className={`border-b border-line align-top ${attention ? "border-l-4 border-l-foreground" : ""}`}>
                  <td className="py-2 pr-3 pl-2">
                    <Link href={`/${lang}/admin/shops/${shop.id}`} className="font-medium underline underline-offset-4">
                      {shop.name}
                    </Link>
                    {attention && <div className="font-semibold">{dict.admin.attention}</div>}
                  </td>
                  <td className="py-2 pr-3">{[shop.city, shop.country].filter(Boolean).join(", ")}</td>
                  <td className="py-2 pr-3">{shop.is_active ? dict.account.yes : dict.account.no}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{shop.item_count}</td>
                  <td className="py-2 pr-3">
                    <span className="font-semibold">{dict.account[`state_${shop.freshness_state}`]}</span>
                    {shop.freshness_state !== "stale" && (
                      <div className="text-muted">
                        {freshnessText(dict, shop.freshness_state, shop.freshness_age_minutes, shop.latest_file_time, shop.timezone)}
                      </div>
                    )}
                  </td>
                  <td className="py-2">{shop.last_error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
