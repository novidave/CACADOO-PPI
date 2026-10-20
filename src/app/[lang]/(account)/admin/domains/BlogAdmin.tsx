import { t, type Dictionary } from "@/i18n/dictionaries";
import { CopyButton } from "@/components/CopyButton";
import { saveBlogLimits } from "./actions";

export interface BlogAdminInfo {
  configured: boolean;
  config_id: boolean;
  redirect_uri: string;
  webhook_url: string;
  verify_token: string | null;
  scopes: string[];
}

/**
 * "Novinky / Blog" on the admin page (database update 37): how many of the newest articles each plan shows (null =
 * all; only admin_save_blog_limits()), and what the Meta app's settings need (the shop-blog function's addresses and
 * the webhook's verify token, shown to the admin only — the function checks is_admin itself).
 */
export function BlogAdmin({
  limits,
  info,
  dict,
  hidden,
}: {
  limits: { plan: "free" | "pro"; max_posts: number | null }[] | null;
  info: BlogAdminInfo | null | undefined;
  dict: Dictionary;
  hidden: React.ReactNode;
}) {
  const a = dict.admin_blog;
  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
  const row = (plan: "free" | "pro") => limits?.find((l) => l.plan === plan);
  return (
    <section id="blog" className="flex flex-col gap-3" aria-labelledby="blog-heading" data-admin-blog>
      <h2 id="blog-heading" className="text-lg font-semibold">
        {a.title}
      </h2>
      <p className="text-sm text-muted">{a.intro}</p>
      {!limits ? (
        <p className="text-sm text-muted">{dict.owner_blog.unavailable}</p>
      ) : (
        <form action={saveBlogLimits} className="flex flex-wrap items-end gap-3 text-sm" data-blog-limits>
          {hidden}
          <label className="flex flex-col gap-1">
            <span>{a.free}</span>
            <input name="free" type="number" min={0} max={10000} defaultValue={row("free")?.max_posts ?? ""} className={`${input} w-28`} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{a.pro}</span>
            <input name="pro" type="number" min={0} max={10000} defaultValue={row("pro")?.max_posts ?? ""} className={`${input} w-28`} />
          </label>
          <button type="submit" className="rounded border border-foreground px-3 py-2 font-medium">
            {a.save}
          </button>
        </form>
      )}
      <h3 className="font-semibold">{a.facebook_title}</h3>
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
