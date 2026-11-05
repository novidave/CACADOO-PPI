import { t, type Dictionary } from "@/i18n/dictionaries";
import { CopyButton } from "@/components/CopyButton";

export interface BlogAdminInfo {
  configured: boolean;
  config_id: boolean;
  redirect_uri: string;
  webhook_url: string;
  verify_token: string | null;
  scopes: string[];
}

/**
 * The Meta app for Novinky (database update 37; on AI a prepojenia since 2026-11-05): whether it is set up and what its
 * settings need — the shop-blog function's addresses and the webhook's verify token, shown to the admin only (the
 * function checks is_admin itself).
 */
export function FacebookAppAdmin({ info, dict }: { info: BlogAdminInfo | null | undefined; dict: Dictionary }) {
  const a = dict.admin_blog;
  return (
    <section id="facebook" className="flex flex-col gap-3" aria-labelledby="facebook-heading">
      <h2 id="facebook-heading" className="text-lg font-semibold">
        {a.facebook_title}
      </h2>
      {info === undefined || info === null ? (
        <p className="text-sm text-muted">{a.facebook_unknown}</p>
      ) : (
        <div className="flex flex-col gap-2 text-sm" data-facebook-app={info.configured ? "on" : "off"}>
          <p className="font-medium">{info.configured ? a.facebook_on : a.facebook_off}</p>
          <p>{info.config_id ? a.config_id_on : t(a.config_id_off, { scopes: info.scopes.join(", ") })}</p>
          {(
            [
              [a.redirect_uri, info.redirect_uri],
              [a.webhook_url, info.webhook_url],
              ...(info.verify_token ? [[a.verify_token, info.verify_token]] : []),
            ] as [string, string][]
          ).map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1">
              <span className="text-muted">{label}</span>
              <span className="flex flex-wrap items-center gap-2">
                <code className="break-all font-mono">{value}</code>
                <CopyButton text={value} labels={{ copy: dict.docs.copy, copied: dict.docs.copied }} />
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
