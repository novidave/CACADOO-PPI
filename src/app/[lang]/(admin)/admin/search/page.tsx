import type { Metadata } from "next";
import { outsideSearchEnabled, sourcesStatus } from "@/lib/productSources";
import { ExternalSearchAdmin, type SearchSettings, type SourcesEnv } from "../_parts/ExternalSearchAdmin";
import { AdminHead, AdminNotice, adminStart, adminTitle, Hidden } from "../_parts/common";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/search">): Promise<Metadata> {
  return adminTitle(params, "search");
}

/**
 * Admin → Vyhľadávanie mimo Cacaduu (2026-11-05; database update 34): the layers, their prices and the allowed web
 * domains (admin_* search functions) and the product-sources function's switches.
 */
export default async function AdminSearchPage({ params, searchParams }: PageProps<"/[lang]/admin/search">) {
  const { lang, dict, session } = await adminStart(params);
  const sp = await searchParams;
  const [searchSettings, sourcesEnv] = await Promise.all([session.supabase.rpc("admin_search_settings"), sourcesStatus(session.supabase)]);
  const hidden = <Hidden lang={lang} keep="" />;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <AdminHead dict={dict} page="search" />
        <AdminNotice dict={dict} sp={sp} />
      </div>
      <ExternalSearchAdmin
        settings={searchSettings.error ? null : (searchSettings.data as SearchSettings)}
        env={sourcesEnv as SourcesEnv | null}
        websiteSecret={outsideSearchEnabled()}
        dict={dict}
        hidden={hidden}
      />
    </div>
  );
}
