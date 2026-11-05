import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { ADMIN_GROUPS, ADMIN_PAGES, adminHref } from "@/lib/adminPages";
import { AdminNav, type AdminNavItem } from "@/components/admin/AdminNav";

// Private pages: never indexed, never cached.
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The admin area's own shell (2026-11-05, canvas "Cacaduu – Admin"): the admin menu (@/components/admin/AdminNav; the
 * map is @/lib/adminPages) beside the page from 768 px, a top bar and a bottom sheet below. Only for is_admin — every
 * admin page calls notFound() unless session.isAdmin itself too, and is_admin() in SQL decides every read and write.
 * The site's own header is not shown here (globals.css, `[data-admin-shell]`). Badges: shops with a domain problem
 * (admin_domain_overview, filter "problem") and places with errors in the last 7 days (admin_server_errors).
 */
export default async function AdminLayout({ children, params }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  if (!session.isAdmin) notFound();
  const [problems, errors] = await Promise.all([
    session.supabase.rpc("admin_domain_overview", { p_q: null, p_status: "problem", p_kind: null }),
    session.supabase.rpc("admin_server_errors", { p_days: 7 }),
  ]);
  const counts = {
    shops: problems.error ? 0 : ((problems.data ?? []) as unknown[]).length,
    errors: errors.error ? 0 : ((errors.data ?? []) as unknown[]).length,
  };
  const n = dict.admin_nav as Record<string, string>;
  const items: AdminNavItem[] = ADMIN_PAGES.map((p) => {
    const badge = p.badge ? counts[p.badge] : 0;
    return {
      key: p.key,
      group: p.group,
      label: n[p.key],
      href: adminHref(lang, p.key),
      ...(badge ? { badge, badgeLabel: t(n[`badge_${p.badge}`], { n: badge }) } : {}),
    };
  });
  const meta = (session.user.user_metadata ?? {}) as { name?: unknown; full_name?: unknown };
  const name = String(meta.full_name ?? meta.name ?? "").trim().slice(0, 80);

  return (
    <div className="flex min-h-svh flex-col bg-white text-[#111] md:flex-row" data-admin-shell>
      <AdminNav
        items={items}
        groups={ADMIN_GROUPS.map((g) => ({ key: g, label: n[`group_${g}`] }))}
        backHref={`/${lang}/dashboard`}
        user={{ name, email: session.user.email ?? "" }}
        labels={{ nav: n.label, pill: n.pill, back: n.back, role: n.role, open: n.open_menu, close: n.close_menu }}
      />
      <div className="flex min-w-0 flex-1 flex-col px-4 pb-10 pt-5 md:px-6 md:pt-[18px]" data-admin-page>
        {children}
      </div>
    </div>
  );
}
