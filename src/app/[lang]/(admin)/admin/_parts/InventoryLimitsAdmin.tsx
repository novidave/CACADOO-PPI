import type { Dictionary } from "@/i18n/dictionaries";
import { saveInventorySettings } from "./actions";
import type { InventoryOverview } from "./InventoryAdmin";

/**
 * The inventory programs' plan settings (database update 49; on Limity plánov since 2026-11-05): how often the stock is
 * fetched per plan and whether Free may connect (admin_save_inventory_settings).
 */
export function InventoryLimitsAdmin({ overview, dict, hidden }: { overview: InventoryOverview | null; dict: Dictionary; hidden: React.ReactNode }) {
  const a = dict.admin_inventory;
  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
  const plan = (p: "free" | "pro") => overview?.plans?.find((r) => r.plan === p);
  return (
    <section id="inventory-limits" className="flex flex-col gap-3" aria-labelledby="inventory-limits-heading">
      <h2 id="inventory-limits-heading" className="text-lg font-semibold">
        {a.title}
      </h2>
      {!overview ? (
        <p className="text-sm text-muted">{dict.owner_blog.unavailable}</p>
      ) : (
        <>
          <h3 className="font-semibold">{a.settings}</h3>
          <form action={saveInventorySettings} className="flex flex-wrap items-end gap-3 text-sm" data-inventory-settings>
            {hidden}
            <label className="flex flex-col gap-1">
              <span>{a.pro_interval}</span>
              <input name="pro_interval" type="number" min={5} max={10080} required defaultValue={plan("pro")?.interval_minutes ?? 15} className={`${input} w-28`} />
            </label>
            <label className="flex items-center gap-2">
              <input name="free_allowed" type="checkbox" defaultChecked={plan("free")?.allowed ?? false} />
              <span>{a.free_allowed}</span>
            </label>
            <label className="flex flex-col gap-1">
              <span>{a.free_interval}</span>
              <input name="free_interval" type="number" min={5} max={10080} required defaultValue={plan("free")?.interval_minutes ?? 1440} className={`${input} w-28`} />
            </label>
            <button type="submit" className="rounded border border-foreground px-3 py-2 font-medium">
              {a.save}
            </button>
          </form>

        </>
      )}
    </section>
  );
}
