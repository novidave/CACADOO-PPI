import type { Metadata } from "next";
import Link from "next/link";
import { ADMIN_GROUPS, ADMIN_PAGES, adminHref } from "@/lib/adminPages";
import { AdminHead, AdminNotice, adminStart, adminTitle } from "./_parts/common";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin">): Promise<Metadata> {
  return adminTitle(params, "home");
}

/**
 * Admin → Prehľad (2026-11-05): the way into every admin page, by the menu's groups (@/lib/adminPages). The overview
 * of the platform's state (tiles, "Treba riešiť", "Služby") comes with phase A2.
 */
export default async function AdminHomePage({ params, searchParams }: PageProps<"/[lang]/admin">) {
  const { lang, dict } = await adminStart(params);
  const sp = await searchParams;
  const n = dict.admin_nav as Record<string, string>;
  return (
    <section className="flex flex-col gap-6" id="overview" aria-label={n.home}>
      <div>
        <AdminHead dict={dict} page="home" />
        <AdminNotice dict={dict} sp={sp} />
      </div>
      {ADMIN_GROUPS.map((g) => (
        <section key={g} className="flex flex-col gap-2" aria-labelledby={`admin-group-${g}`}>
          <h2 id={`admin-group-${g}`} className="text-xs font-bold uppercase tracking-[.06em] text-[#5C5C5C]">
            {n[`group_${g}`]}
          </h2>
          <ul className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {ADMIN_PAGES.filter((p) => p.group === g && p.key !== "home").map((p) => (
              <li key={p.key}>
                <Link href={adminHref(lang, p.key)} className="flex h-full min-h-11 flex-col gap-0.5 rounded-2xl border border-[#E4E4E4] p-4 text-[#111] no-underline hover:border-[#111]" data-admin-link={p.key}>
                  <strong className="text-base">{n[p.key]}</strong>
                  <span className="text-sm text-[#5C5C5C]">{n[`${p.key}_intro`]}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
