import { t, type Dictionary } from "@/i18n/dictionaries";
import { HEALTH_COLORS } from "@/lib/adminOverview";
import { CopyButton } from "@/components/CopyButton";
import { cardClass } from "@/components/owner/ui";
import { DotText } from "./common";

export interface BlogAdminInfo {
  configured: boolean;
  config_id: boolean;
  redirect_uri: string;
  webhook_url: string;
  verify_token: string | null;
  scopes: string[];
}

/**
 * The Meta app for Novinky (database update 37; on AI a prepojenia since 2026-11-05, artboard 7): whether it is set up
 * (a dot + words) and what its settings need — the shop-blog function's addresses and the webhook's verify token, each
 * with "Kopírovať", shown to the admin only (the function checks is_admin itself). A function that does not answer =
 * grey "neodpovedá".
 */
export function FacebookAppAdmin({ info, dict }: { info: BlogAdminInfo | null | undefined; dict: Dictionary }) {
  const a = dict.admin_blog;
  const h = dict.admin_home;
  const silent = info === undefined || info === null;
  return (
    <section id="facebook" className={`${cardClass} min-w-0 !gap-0`} aria-labelledby="facebook-heading" data-facebook-app={silent ? "silent" : info.configured ? "on" : "off"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="facebook-heading" className="text-[19px] font-bold">
          {a.facebook_title}
        </h2>
        <DotText color={silent ? HEALTH_COLORS.off : info.configured ? HEALTH_COLORS.ok : HEALTH_COLORS.off}>
          {silent ? h.svc_silent : info.configured ? h.svc_set : h.svc_not_set}
        </DotText>
      </div>
      {silent ? (
        <p className="pt-1 text-sm text-[#5C5C5C]">{a.facebook_unknown}</p>
      ) : (
        <>
          <p className="pt-1 text-sm text-[#5C5C5C]">{info.configured ? a.facebook_on : a.facebook_off}</p>
          <p className="pb-3 pt-1 text-sm text-[#5C5C5C]">{info.config_id ? a.config_id_on : t(a.config_id_off, { scopes: info.scopes.join(", ") })}</p>
          {(
            [
              [a.redirect_uri, info.redirect_uri],
              [a.webhook_url, info.webhook_url],
              ...(info.verify_token ? [[a.verify_token, info.verify_token]] : []),
            ] as [string, string][]
          ).map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1 border-t border-[#E4E4E4] py-3">
              <span className="text-xs font-bold uppercase tracking-[.04em] text-[#5C5C5C]">{label}</span>
              <span className="flex flex-wrap items-center justify-between gap-2">
                <code className="min-w-0 break-all font-mono text-[13px]">{value}</code>
                <CopyButton text={value} labels={{ copy: dict.docs.copy, copied: dict.docs.copied }} />
              </span>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
