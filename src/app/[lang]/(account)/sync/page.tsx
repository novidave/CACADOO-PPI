import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { FolderSync } from "@/components/FolderSync";
import { InstallApp } from "@/components/InstallApp";
import { DbError } from "@/components/DbError";

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
export default async function SyncPage({ params, searchParams }: PageProps<"/[lang]/sync">) {
  const { lang } = await params;
  const sp = await searchParams;
  const chosen = typeof sp.shop === "string" ? sp.shop : undefined;
  if (!isLocale(lang)) notFound();
  const [dict, { supabase, user, isAdmin }] = await Promise.all([getDictionary(lang), requireUser(lang)]);

  const { data: memberships, error: e1 } = await supabase.from("shop_members").select("shop_id").eq("user_id", user.id);
  if (e1) return <DbError message={e1.message} dict={dict} />;
  const shopIds = (memberships ?? []).map((m) => m.shop_id as string);

  let shops: SyncShop[] = [];
  let pickList: SyncShop[] = [];
  if (shopIds.length > 0) {
    const { data, error } = await supabase.from("shops").select("id, name, timezone").in("id", shopIds).order("name");
    if (error) return <DbError message={error.message} dict={dict} />;
    shops = (data ?? []) as SyncShop[];
  } else if (isAdmin) {
    // The admin is usually not an owner; let them rehearse with any shop.
    const { data, error } = await supabase.rpc("admin_shops").select("id, name, timezone").order("name");
    if (error) return <DbError message={error.message} dict={dict} />;
    pickList = (data ?? []) as SyncShop[];
    shops = pickList.filter((s) => s.id === chosen);
  }

  const labels = {
    ...dict.sync,
    latest_file: dict.dashboard.latest_file,
    never: dict.account.never,
    state_current: dict.account.state_current,
    state_recent: dict.account.state_recent,
    state_stale: dict.account.state_stale,
  };

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{dict.sync.title}</h1>
        <p className="text-sm">{dict.sync.intro}</p>
      </header>

      {pickList.length > 0 && (
        <nav className="flex flex-wrap gap-3 text-sm" aria-label={dict.dashboard.shop}>
          {pickList.map((s) => (
            <a
              key={s.id}
              href={`/${lang}/sync?shop=${s.id}`}
              className={s.id === chosen ? "font-semibold underline underline-offset-4" : "text-muted hover:underline"}
            >
              {s.name}
            </a>
          ))}
        </nav>
      )}

      {shops.length === 0 ? (
        pickList.length === 0 && <p className="border border-line p-4">{dict.sync.no_shop}</p>
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
