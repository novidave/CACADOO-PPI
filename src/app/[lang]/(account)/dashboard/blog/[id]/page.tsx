import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { facebookEnabled, photoSrc } from "@/lib/blog";
import { blogPath, blogUrl } from "@/lib/blogFormat";
import { getShopLanguages } from "@/lib/shopLanguages";
import { utcToLocalInput } from "@/lib/format";
import { requestTime } from "@/lib/requestTime";
import type { MyShop } from "@/lib/myShops";
import { siteUrl } from "@/lib/site";
import { BlogEditor, type EditorPost } from "@/components/BlogEditor";
import { FacebookPagePicker } from "@/components/FacebookPagePicker";
import type { FacebookRow } from "../page";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/blog/[id]">): Promise<Metadata> {
  const { lang, id } = await params;
  if (!isLocale(lang)) return {};
  const b = (await getDictionary(lang)).owner_blog;
  return { title: id === "new" ? b.editor_new : b.editor_edit };
}

/**
 * "Nový článok" (/dashboard/blog/new) and "Upraviť článok" (/dashboard/blog/<id>): the editor with its publish dialog.
 * Back from Facebook's login (?fb_pick=…&resume=publish) the owner picks the Page here and the dialog opens again.
 */
export default async function BlogEditorPage({ params, searchParams }: PageProps<"/[lang]/dashboard/blog/[id]">) {
  const { lang: langValue, id } = await params;
  if (!isLocale(langValue)) notFound();
  const lang: Locale = langValue;
  if (id !== "new" && !UUID.test(id)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const sp = await searchParams;
  const b = dict.owner_blog;

  const { data: shopRows } = await supabase.rpc("my_shops");
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);

  let post: EditorPost | null = null;
  let shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];
  if (id !== "new") {
    const { data, error } = await supabase.rpc("owner_blog_post", { p_post_id: id });
    if (error || !data) notFound();
    const row = data as Omit<EditorPost, "photos"> & { shop_id: string; photos: { id: string; kind: "photo" | "video"; status: string; small: string | null }[] };
    shop = shops.find((s) => s.id === row.shop_id) ?? notFound();
    post = {
      ...row,
      photos: row.photos.filter((p) => p.status === "ready" && p.small).map((p) => ({ id: p.id, kind: p.kind, src: photoSrc(p.small!) })),
    };
  }

  const [connection, settings, fbOn, host] = await Promise.all([
    supabase.from("facebook_connections").select("page_name, page_picture, status").eq("shop_id", shop.id).maybeSingle(),
    supabase.from("shop_blog_settings").select("last_choice").eq("shop_id", shop.id).maybeSingle(),
    facebookEnabled(),
    supabase.rpc("shop_site", { p_slug: shop.slug }),
  ]);
  const fb = (connection.data as Pick<FacebookRow, "page_name" | "page_picture" | "status"> | null) ?? null;
  const home = (await getShopLanguages(shop.slug, shop.country)).home;
  const place = { shopSlug: shop.slug, country: shop.country, host: typeof host.data === "string" && host.data ? host.data : null, homeLang: home };
  const now = requestTime();
  const tomorrow = utcToLocalInput(new Date(now + 86_400_000), shop.timezone).replace(/T\d\d:\d\d$/, "T08:00");
  const pick = first(sp.fb_pick);
  const err = first(sp.err);
  const resume = first(sp.resume) === "publish";
  const back = `/${lang}/dashboard/blog?${new URLSearchParams({ shop: shop.slug })}`;
  // Where the editor goes after the Page is picked: the same post, the dialog again.
  const here = `/${lang}/dashboard/blog/${id}?${new URLSearchParams({
    shop: shop.slug,
    ...(resume ? { resume: "publish" } : {}),
    ...(first(sp.at) ? { at: first(sp.at)! } : {}),
  })}`;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm">
          <Link href={back} className="underline underline-offset-4">
            {b.back}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{post ? b.editor_edit : b.editor_new}</h1>
        <p className="text-muted">{shop.name}</p>
      </header>
      {err && (
        <p role="alert" className="border border-line p-3 text-sm">
          {(b as Record<string, string>)[`error_${err}`] ?? t(b.error_failed, { message: err })}
        </p>
      )}
      {fbOn && pick && <FacebookPagePicker pendingId={pick} doneUrl={here} labels={{ ...b, saving: b.saving }} />}
      <BlogEditor
        // Only the way back from Facebook's login (pick → resume) starts the editor again, with the dialog open.
        key={pick ? "pick" : resume ? "resume" : "edit"}
        lang={lang}
        shopId={shop.id}
        shopSlug={shop.slug}
        timeZone={shop.timezone}
        post={post}
        facebook={{
          enabled: fbOn,
          state: !fb ? "not_connected" : fb.status === "expired" ? "expired" : "connected",
          page: fb ? { name: fb.page_name, picture: fb.page_picture } : null,
        }}
        lastChoice={((settings.data as { last_choice?: "web" | "web_fb" | null } | null)?.last_choice ?? null)}
        // The post's own address, in the shop's language (as on Facebook).
        postUrl={`${blogUrl(siteUrl(), home, place)}/`}
        viewPath={place.host ? `https://${place.host}${blogPath(home, place, true)}/` : `${blogPath(lang, place, false)}/`}
        defaultAt={first(sp.at) ?? tomorrow}
        resume={{ publish: resume && !pick, at: first(sp.at) ?? null }}
        now={now}
        labels={b}
      />
    </div>
  );
}
