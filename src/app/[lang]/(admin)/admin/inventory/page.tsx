import type { Metadata } from "next";
import Link from "next/link";
import { t } from "@/i18n/dictionaries";
import { adminHref } from "@/lib/adminPages";
import { InventoryAdmin, type InventoryOverview } from "../_parts/InventoryAdmin";
import { AdminHead, AdminNotice, adminStart, adminTitle, Hidden } from "../_parts/common";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/inventory">): Promise<Metadata> {
  return adminTitle(params, "inventory");
}

/**
 * Admin → Skladové programy (2026-11-05; database update 49): the programs (admin_set_inventory_provider) and the
 * connections, never a key. The intervals per plan are on Limity plánov.
 */
export default async function AdminInventoryPage({ params, searchParams }: PageProps<"/[lang]/admin/inventory">) {
  const { lang, dict, session } = await adminStart(params);
  const sp = await searchParams;
  const inventory = await session.supabase.rpc("admin_inventory_overview");
  const hidden = <Hidden lang={lang} keep="" />;
  const overview = inventory.error ? null : (inventory.data as InventoryOverview);
  const plan = (p: "free" | "pro") => overview?.plans?.find((r) => r.plan === p);
  const a = dict.admin_inventory;
  const pro = plan("pro")?.interval_minutes;
  const free = plan("free");
  return (
    <div className="flex flex-col gap-4">
      <div>
        <AdminHead dict={dict} page="inventory" />
        <AdminNotice dict={dict} sp={sp} />
      </div>
      <InventoryAdmin
        overview={overview}
        lang={lang}
        dict={dict}
        hidden={hidden}
        limitsNote={
          <p className="text-[15px]" data-inventory-interval>
            {pro !== undefined && (
              <>
                {t(a.interval_line, { pro, free: free?.allowed ? t(a.free_every, { n: free.interval_minutes }) : a.free_off })}
                {" · "}
              </>
            )}
            <Link href={adminHref(lang, "limits", undefined, "inventory-limits")} className="font-semibold underline underline-offset-4" data-inventory-limits-link>
              {a.limits_change}
            </Link>
          </p>
        }
      />
    </div>
  );
}
