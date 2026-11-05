import type { Dictionary } from "@/i18n/dictionaries";
import { saveBlogLimits } from "./actions";

/**
 * "Novinky / Blog" limits (database update 37; on Limity plánov since 2026-11-05): how many of the newest articles
 * each plan shows (null = all; only admin_save_blog_limits()).
 */
export function BlogLimitsAdmin({
  limits,
  dict,
  hidden,
}: {
  limits: { plan: "free" | "pro"; max_posts: number | null }[] | null;
  dict: Dictionary;
  hidden: React.ReactNode;
}) {
  const a = dict.admin_blog;
  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
  const row = (plan: "free" | "pro") => limits?.find((l) => l.plan === plan);
  return (
    <section id="blog-limits" className="flex flex-col gap-3" aria-labelledby="blog-limits-heading" data-admin-blog>
      <h2 id="blog-limits-heading" className="text-lg font-semibold">
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
    </section>
  );
}
