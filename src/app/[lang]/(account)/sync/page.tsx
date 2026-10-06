import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { FolderSync } from "@/components/FolderSync";
import { InstallApp } from "@/components/InstallApp";
import { DbError } from "@/components/DbError";
import { folderSyncLabels } from "@/lib/syncLabels";

export async function generateMetadata({ params }: PageProps<"/[lang]/sync">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).sync.title };
}

interface SyncShop {
  id: string;
  name: string;
  timezone: string;
}

/**
 * The shop PC's PPI window (the installed app starts here): connect the folder the
 * stock software exports to; while open, the newest file is sent every 15 minutes.
 */
export default async function SyncPage({ params }: PageProps<"/[lang]/sync">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, { supabase, user }] = await Promise.all([getDictionary(lang), requireUser(lang)]);

  const { data: memberships, error: e1 } = await supabase.from("shop_members").select("shop_id").eq("user_id", user.id);
  if (e1) return <DbError message={e1.message} dict={dict} />;
  const shopIds = (memberships ?? []).map((m) => m.shop_id as string);

  let shops: SyncShop[] = [];
  if (shopIds.length > 0) {
    const { data, error } = await supabase.from("shops").select("id, name, timezone").in("id", shopIds).order("name");
    if (error) return <DbError message={error.message} dict={dict} />;
    shops = (data ?? []) as SyncShop[];
  }

  const labels = folderSyncLabels(dict);

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{dict.sync.title}</h1>
        <p className="text-sm">{dict.sync.intro}</p>
      </header>

      {shops.length === 0 ? (
        <p className="border border-line p-4">{dict.sync.no_shop}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {shops.map((shop) => (
            <FolderSync
              key={shop.id}
              shopId={shop.id}
              shopName={shop.name}
              showName={shops.length > 1}
              lang={lang}
              timeZone={shop.timezone}
              loginHref={`/${lang}/login`}
              labels={labels}
            />
          ))}
        </div>
      )}

      <InstallApp labels={dict.sync} />
    </div>
  );
}
