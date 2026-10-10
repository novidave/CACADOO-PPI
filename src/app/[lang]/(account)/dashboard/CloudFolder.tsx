import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { formatDateTime, localDay } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { CloudFolderPicker } from "@/components/CloudFolderPicker";
import { PendingButton } from "@/components/PendingButton";
import {
  backfillCloud,
  browseCloudFolders,
  connectCloud,
  createCloudFolder,
  disconnectCloud,
  setCloudFolder,
} from "./cloudActions";
import type { Supabase } from "./ShopDocuments";

/** The shop's cloud connection as its owners see it (cloud_connections; never the tokens). */
export interface CloudRow {
  provider: "onedrive" | "dropbox";
  account_name: string | null;
  account_email: string | null;
  folder_path: string;
  status: "ok" | "expired" | "error";
  last_error: string | null;
  connected_at: string;
  last_success_at: string | null;
  failing_since: string | null;
}

/** {connection} (null = not connected); null before database update 23. */
export async function loadCloud(supabase: Supabase, shopId: string): Promise<{ connection: CloudRow | null } | null> {
  const { data, error } = await supabase
    .from("cloud_connections")
    .select("provider, account_name, account_email, folder_path, status, last_error, connected_at, last_success_at, failing_since")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) return null;
  return { connection: (data as CloudRow | null) ?? null };
}

/** One line while the section is closed: "OneDrive · /Cacadoo/Obchod" or "Nepripojený". */
export function cloudSummary(cloud: { connection: CloudRow | null } | null, dict: Dictionary): string {
  const c = dict.cloud;
  if (!cloud) return c.unavailable;
  const k = cloud.connection;
  if (!k) return c.summary_off;
  const provider = c[`provider_${k.provider}`];
  return k.status === "expired" ? t(c.summary_expired, { provider }) : t(c.summary_on, { provider, folder: k.folder_path });
}

/** The default target folder: /Cacadoo/<shop name> (the function cleans the name for the cloud). */
const defaultFolder = (shop: MyShop) => `/Cacadoo/${shop.name.replace(/[\\/]/g, "-").trim() || "Obchod"}`;

/**
 * "Cloudový priečinok" in Môj obchod (paid plan): connect OneDrive or Dropbox with OAuth,
 * pick or make the target folder, see how the copies go, copy older conversations once,
 * disconnect. Every action goes through the cloud-export function with the owner's login.
 */
export function CloudFolder({
  cloud,
  shop,
  lang,
  dict,
  hasPlan,
  hidden,
  notice,
}: {
  cloud: { connection: CloudRow | null } | null;
  shop: MyShop;
  lang: Locale;
  dict: Dictionary;
  hasPlan: boolean;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  notice: React.ReactNode;
}) {
  const c = dict.cloud;
  if (!cloud) return <p className="text-sm text-muted">{c.unavailable}</p>;
  const k = cloud.connection;
  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
  const when = (iso: string) => formatDateTime(iso, lang, shop.timezone);
  const permissions = (
    <details className="text-sm">
      <summary className="cursor-pointer underline underline-offset-4">{c.permission_title}</summary>
      <ul className="mt-2 list-disc pl-6">
        <li>{c.permission_onedrive}</li>
        <li>{c.permission_dropbox}</li>
        <li>{c.permission_common}</li>
      </ul>
    </details>
  );
  const connectButtons = (providers: ("onedrive" | "dropbox")[], label?: string) => (
    <div className="flex flex-wrap gap-2">
      {providers.map((p) => (
        <button
          key={p}
          type="submit"
          name="provider"
          value={p}
          className="rounded border border-foreground px-4 py-2 font-medium"
          data-connect={p}
        >
          {label ?? c[`connect_${p}`]}
        </button>
      ))}
    </div>
  );

  if (!k) {
    return (
      <>
        {notice}
        <p className="text-sm">{c.intro}</p>
        {!hasPlan ? (
          <p className="border border-line p-3 text-sm">{c.needs_plan}</p>
        ) : (
          <form action={connectCloud} className="flex flex-col gap-3" data-cloud-connect>
            {hidden({ at: "cloud" })}
            <label className="flex flex-col gap-1">
              <span className="text-sm">{c.folder}</span>
              <input name="folder" defaultValue={defaultFolder(shop)} maxLength={400} className={input} />
              <span className="text-xs text-muted">{c.folder_hint}</span>
            </label>
            <p className="text-xs text-muted">{c.share_link}</p>
            {connectButtons(["onedrive", "dropbox"])}
            {permissions}
          </form>
        )}
        <p className="text-xs text-muted">{t(c.structure, { folder: defaultFolder(shop) })}</p>
      </>
    );
  }

  const statusText =
    k.status === "ok" ? c.status_ok : k.status === "expired" ? c.status_expired : t(c.status_error, { message: k.last_error ?? "" });
  const today = localDay(new Date(), shop.timezone);
  return (
    <>
      {notice}
      <p className="text-sm">{c.intro}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm" data-cloud-status={k.status}>
        <dt className="text-muted">{c.provider}</dt>
        <dd>{c[`provider_${k.provider}`]}</dd>
        {(k.account_name || k.account_email) && (
          <>
            <dt className="text-muted">{c.account}</dt>
            <dd className="break-all">{[k.account_name, k.account_email].filter(Boolean).join(" · ")}</dd>
          </>
        )}
        <dt className="text-muted">{c.folder}</dt>
        <dd className="break-all">{k.folder_path}</dd>
        <dt className="text-muted">{c.status}</dt>
        <dd className="font-semibold">{statusText}</dd>
        <dt className="text-muted">{c.last_saved}</dt>
        <dd>{k.last_success_at ? when(k.last_success_at) : c.never}</dd>
      </dl>
      {k.failing_since && k.status !== "expired" && <p className="text-sm">{t(c.failing_since, { when: when(k.failing_since) })}</p>}
      {k.status === "expired" && hasPlan && (
        <form action={connectCloud}>
          {hidden({ at: "cloud", folder: k.folder_path })}
          {connectButtons([k.provider], c.reconnect)}
        </form>
      )}
      <p className="text-xs text-muted">{t(c.structure, { folder: k.folder_path })}</p>

      {hasPlan && k.status !== "expired" && (
        <section className="flex flex-col gap-2 border-t border-line pt-3">
          <h3 className="font-semibold">{c.change_folder}</h3>
          <CloudFolderPicker
            shopId={shop.id}
            folder={k.folder_path}
            hidden={{ lang, shop_id: shop.id, shop_slug: shop.slug, at: "cloud" }}
            labels={{
              folder: c.folder,
              folder_hint: c.folder_hint,
              folder_path: c.folder_path,
              folder_save: c.folder_save,
              browse: c.browse,
              folder_up: c.folder_up,
              folder_empty: c.folder_empty,
              folder_loading: c.folder_loading,
              folder_failed: c.folder_failed,
              folder_new: c.folder_new,
              folder_create: c.folder_create,
              folder_use: c.folder_use,
              saving: dict.owner.saving,
              errors: {
                folder: c.error_folder,
                share_link: c.share_link,
                expired: c.error_expired,
                cloud: c.error_cloud,
                no_cloud: c.error_no_cloud,
                bad_folder: c.error_bad_folder,
              },
            }}
            save={setCloudFolder}
            browse={browseCloudFolders}
            create={createCloudFolder}
          />
        </section>
      )}

      {hasPlan && (
        <form action={backfillCloud} className="flex flex-col gap-2 border-t border-line pt-3" data-cloud-backfill>
          {hidden({ at: "cloud" })}
          <h3 className="font-semibold">{c.backfill_title}</h3>
          <p className="text-sm text-muted">{c.backfill_intro}</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-sm">{dict.conversations.from}</span>
              <input type="date" name="from" required max={today} className={input} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm">{dict.conversations.to}</span>
              <input type="date" name="to" required defaultValue={today} max={today} className={input} />
            </label>
            <PendingButton pending={dict.owner.saving}>{c.backfill_button}</PendingButton>
          </div>
        </form>
      )}

      <form action={disconnectCloud} className="flex flex-col gap-2 border-t border-line pt-3" data-cloud-disconnect>
        {hidden({ at: "cloud" })}
        <h3 className="font-semibold">{c.disconnect_title}</h3>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="confirm" required />
          {c.disconnect_confirm}
        </label>
        {k.provider === "onedrive" && <p className="text-xs text-muted">{c.disconnect_microsoft}</p>}
        <PendingButton pending={dict.owner.saving}>{c.disconnect_button}</PendingButton>
      </form>
    </>
  );
}
