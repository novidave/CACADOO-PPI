import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { AccountNav } from "@/components/AccountNav";

// Private pages: never indexed, never cached.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AccountLayout({ children, params }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  // Shoppers waiting for an answer (database update 59: they left a phone or e-mail after an unanswered question).
  const waitingRes = await session.supabase.rpc("owner_callbacks_waiting");
  const waiting = waitingRes.error ? 0 : ((waitingRes.data ?? []) as { waiting: number }[]).reduce((n, r) => n + Number(r.waiting), 0);
  // Shop owners; the admin also gets "Predplatné a domény" (update 25), its only admin page.
  const links = [
    { href: `/${lang}/dashboard`, label: dict.account.dashboard, shopPage: true },
    { href: `/${lang}/dashboard/content`, label: dict.account.content_page, shopPage: true },
    { href: `/${lang}/dashboard/blog`, label: dict.account.blog_page, shopPage: true },
    {
      href: `/${lang}/dashboard/assistant`,
      label: dict.account.assistant_page,
      shopPage: true,
      badge: waiting,
      badgeLabel: t(dict.callbacks.badge, { n: waiting }),
      // update 63: Kontakty, Rezervácie and the conversations are tabs of Asistent
      also: [`/${lang}/dashboard/contacts`, `/${lang}/dashboard/bookings`, `/${lang}/dashboard/conversations`],
    },
    { href: `/${lang}/dashboard/hours-sms`, label: dict.account.hours_sms_page, shopPage: true },
    { href: `/${lang}/dashboard/ai`, label: dict.account.ai_page },
    { href: `/${lang}/dashboard/translations`, label: dict.account.translations_page, shopPage: true },
    { href: `/${lang}/sync`, label: dict.account.sync, shopPage: true },
    { href: `/${lang}/dashboard/plan`, label: dict.account.plan_page, shopPage: true },
    { href: `/${lang}/password`, label: dict.account.password },
    ...(session.isAdmin
      ? [
          { href: `/${lang}/admin/domains`, label: dict.admin_domains.nav },
          { href: `/${lang}/admin/translations`, label: dict.admin_tr.nav },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-3 text-sm">
        <AccountNav links={links} />
        <span className="ml-auto text-muted">{t(dict.account.signed_in_as, { email: session.user.email ?? "" })}</span>
        <form action="/auth/signout" method="post">
          <button type="submit" className="underline underline-offset-4">
            {dict.account.sign_out}
          </button>
        </form>
      </nav>
      {children}
    </div>
  );
}
