import type { Metadata } from "next";
import { ErrorsAdmin, type ServerErrorRow } from "../_parts/ErrorsAdmin";
import { AdminHead, AdminNotice, adminStart, adminTitle } from "../_parts/common";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/errors">): Promise<Metadata> {
  return adminTitle(params, "errors");
}

/**
 * Admin → Chyby (2026-11-05; database update 42): the website's server errors of the last 7 days, grouped by place
 * (admin_server_errors() checks is_admin()).
 */
export default async function AdminErrorsPage({ params, searchParams }: PageProps<"/[lang]/admin/errors">) {
  const { lang, dict, session } = await adminStart(params);
  const sp = await searchParams;
  const serverErrors = await session.supabase.rpc("admin_server_errors", { p_days: 7 });
  return (
    <div className="flex flex-col gap-8">
      <div>
        <AdminHead dict={dict} page="errors" />
        <AdminNotice dict={dict} sp={sp} />
      </div>
      <ErrorsAdmin rows={serverErrors.error ? null : ((serverErrors.data ?? []) as ServerErrorRow[])} lang={lang} dict={dict} />
    </div>
  );
}
