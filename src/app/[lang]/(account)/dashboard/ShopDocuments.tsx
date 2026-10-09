import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import type { getSession } from "@/lib/auth";
import { formatDate, formatDateTime, isPast } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { DocsWork, DocUpload, PictureUpload, type FolderOption } from "@/components/DocUpload";
import { FolderKeyForm } from "@/components/FolderKeyForm";
import { PendingButton } from "@/components/PendingButton";
import {
  acceptDocsTerms,
  createFolderKey,
  deleteDocOrPicture,
  deleteFolder,
  revokeFolderKey,
  saveDocument,
  saveFolder,
  savePicture,
} from "./docActions";

export type Supabase = NonNullable<Awaited<ReturnType<typeof getSession>>>["supabase"];

export interface Folder {
  id: string;
  name: string;
  is_public: boolean;
}
export interface Doc {
  id: string;
  folder_id: string;
  name: string;
  description: string | null;
  pages: number;
  lang: string | null;
  status: "uploading" | "processing" | "ready" | "error";
  error: string | null;
  assistant_enabled: boolean;
  downloadable: boolean;
  created_at: string;
}
export interface Picture {
  id: string;
  folder_id: string;
  document_id: string | null;
  page: number | null;
  title: string;
  caption: string | null;
  description: string | null;
  description_by_owner: boolean;
  show: boolean;
  status: "uploading" | "pending" | "working" | "ready" | "error";
  created_at: string;
}
export interface Key {
  id: string;
  label: string;
  folder_ids: string[];
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
}
interface Links {
  pictures: Record<string, string>;
  limits?: { files: number; pages: number; pictures: number };
}

const inputClass = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";

function languageName(code: string | null, lang: Locale): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([lang], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The shop's folders, documents, pictures and access keys, as its owner reads them (RLS). */
export interface ShopDocsData {
  folders: Folder[];
  docs: Doc[];
  pictures: Picture[];
  keys: Key[];
  /** Pictures the AI still has to look at. */
  waiting: number;
  termsAccepted: boolean;
}

/** Loaded once per page for "Documents for the assistant" and the private files under "Export folder". */
export async function loadShopDocs(supabase: Supabase, shopId: string): Promise<ShopDocsData | null> {
  const [folderRes, docRes, picRes, scanRes, keyRes, termsRes] = await Promise.all([
    supabase.from("shop_folders").select("id, name, is_public").eq("shop_id", shopId).order("is_public", { ascending: false }).order("name"),
    supabase
      .from("shop_documents")
      .select("id, folder_id, name, description, pages, lang, status, error, assistant_enabled, downloadable, created_at")
      .eq("shop_id", shopId)
      .order("created_at", { ascending: false }),
    supabase
      .from("shop_pictures")
      .select("id, folder_id, document_id, page, title, caption, description, description_by_owner, show, status, created_at")
      .eq("shop_id", shopId)
      .eq("kind", "picture")
      .neq("status", "uploading")
      .order("document_id", { nullsFirst: true })
      .order("page")
      .order("created_at"),
    supabase.from("shop_pictures").select("id", { count: "exact", head: true }).eq("shop_id", shopId).in("status", ["pending", "working"]),
    supabase
      .from("folder_keys")
      .select("id, label, folder_ids, expires_at, revoked_at, created_at, last_used_at, use_count")
      .eq("shop_id", shopId)
      .order("created_at", { ascending: false }),
    supabase.from("shops").select("docs_terms_accepted_at").eq("id", shopId).maybeSingle(),
  ]);
  // Before database update 20 there is nothing to load.
  if (folderRes.error || docRes.error || picRes.error || keyRes.error || termsRes.error) return null;
  return {
    folders: (folderRes.data ?? []) as Folder[],
    docs: (docRes.data ?? []) as Doc[],
    pictures: (picRes.data ?? []) as Picture[],
    keys: (keyRes.data ?? []) as Key[],
    waiting: scanRes.count ?? 0,
    termsAccepted: Boolean(termsRes.data?.docs_terms_accepted_at),
  };
}

/** "Open" for the owner: /api/owner/files redirects to a 10-minute signed address (owner only). */
export function ownerFileUrl(kind: "document" | "picture", id: string): string {
  return `/api/owner/files/${kind}/${id}`;
}

/** An access key that still opens folders: not revoked, not expired. */
export function keyActive(key: Key): boolean {
  return !key.revoked_at && !isPast(key.expires_at);
}

/**
 * "Documents for the assistant": PDFs and pictures the shop's assistant uses to answer
 * shoppers (never products: items, prices and stock come only from the stock file),
 * the Public and private folders, and access keys for the private ones.
 */
export async function ShopDocuments({
  supabase,
  data,
  shop,
  lang,
  dict,
  hasPlan,
  notice,
}: {
  supabase: Supabase;
  data: ShopDocsData | null;
  shop: MyShop;
  lang: Locale;
  dict: Dictionary;
  hasPlan: boolean;
  notice: React.ReactNode;
}) {
  const d = dict.docs;
  // Before database update 20 the section only says that it is not available yet.
  if (!data) return <p className="text-sm text-muted">{d.unavailable}</p>;
  const { folders, docs, pictures, keys, waiting, termsAccepted } = data;

  // Without the plan and with nothing uploaded: only what the feature is.
  if (!hasPlan && docs.length === 0 && pictures.length === 0 && keys.length === 0) {
    return (
      <>
        {notice}
        <p className="text-sm">{d.intro}</p>
        <p className="text-sm font-medium">{d.never_products}</p>
        <p className="border border-line p-3 text-sm">{d.needs_plan}</p>
      </>
    );
  }

  // Signed addresses (10 minutes) for the owner's thumbnails, and the shop's limits (only
  // asked for when the shop uses documents: it is a call to the doc-ingest function).
  const { data: links } =
    hasPlan || pictures.length
      ? await supabase.functions.invoke<Links>("doc-ingest", {
          body: { action: "links", shop_id: shop.id, picture_ids: pictures.map((p) => p.id) },
        })
      : { data: null };
  const limits = links?.limits ?? null;

  const folderName = (id: string) => {
    const folder = folders.find((f) => f.id === id);
    return folder ? (folder.is_public ? d.public_folder : folder.name) : "–";
  };
  const options: FolderOption[] = folders.map((f) => ({ id: f.id, name: f.is_public ? d.public_folder : f.name }));
  const privateFolders = folders.filter((f) => !f.is_public);
  const ownPictures = pictures.filter((p) => !p.document_id);
  const pagesUsed = docs.reduce((sum, doc) => sum + doc.pages, 0);
  const picturesLeft = limits ? limits.pictures - pictures.length : 0;
  const date = (iso: string) => formatDate(iso, lang, shop.timezone);
  const hidden = (extra: Record<string, string> = {}) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="shop_id" value={shop.id} />
      <input type="hidden" name="shop_slug" value={shop.slug} />
      {Object.entries(extra).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
  const canUpload = hasPlan && termsAccepted && Boolean(limits);

  return (
    <>
      {notice}
      <p className="text-sm">{d.intro}</p>
      <p className="text-sm font-medium">{d.never_products}</p>
      {!hasPlan && <p className="border border-line p-3 text-sm">{d.needs_plan}</p>}

      {hasPlan && !termsAccepted ? (
        <form action={acceptDocsTerms} className="flex flex-col gap-3 border border-foreground p-3">
          {hidden()}
          <label className="flex items-start gap-2">
            <input type="checkbox" name="agree" required className="mt-1" />
            <span>{d.consent}</span>
          </label>
          <PendingButton pending={dict.owner.saving}>{d.consent_button}</PendingButton>
        </form>
      ) : (
        termsAccepted && <p className="text-sm text-muted">{d.consent}</p>
      )}

      {limits ? (
        <p className="text-sm">
          {t(d.usage, {
            files: docs.length,
            max_files: limits.files,
            pages: pagesUsed,
            max_pages: limits.pages,
            pictures: pictures.length,
            max_pictures: limits.pictures,
          })}
        </p>
      ) : (
        hasPlan && <p className="text-sm text-muted">{d.function_missing}</p>
      )}
      {hasPlan && waiting > 0 && <DocsWork shopId={shop.id} waiting={waiting} labels={d} />}

      {canUpload && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <DocUpload shopId={shop.id} folders={options} lang={lang} picturesLeft={picturesLeft} labels={d} />
          <PictureUpload shopId={shop.id} folders={options} lang={lang} labels={d} />
        </div>
      )}

      <h3 className="pt-2 font-semibold">{d.folders_title}</h3>
      <ul className="flex flex-col gap-2 text-sm">
        {folders.map((f) => {
          const count = docs.filter((doc) => doc.folder_id === f.id).length + ownPictures.filter((p) => p.folder_id === f.id).length;
          return (
            <li key={f.id} className="flex flex-col gap-1 border-b border-line pb-2">
              <span>
                <span className="font-medium">{f.is_public ? d.public_folder : f.name}</span>
                <span className="text-muted"> · {f.is_public ? d.public_note : d.private_note} · {t(d.folder_count, { n: count })}</span>
              </span>
              {!f.is_public && (
                <div className="flex flex-wrap items-end gap-2">
                  <form action={saveFolder} className="flex gap-2">
                    {hidden({ folder_id: f.id })}
                    <input name="name" defaultValue={f.name} maxLength={60} required aria-label={d.folder_name} className={`${inputClass} min-w-0 py-1`} />
                    <button type="submit" className="underline underline-offset-4">{d.rename}</button>
                  </form>
                  <form action={deleteFolder}>
                    {hidden({ folder_id: f.id })}
                    <button type="submit" className="underline underline-offset-4">{d.delete}</button>
                  </form>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {hasPlan && (
        <form action={saveFolder} className="flex flex-wrap items-end gap-2">
          {hidden()}
          <label className="flex flex-col gap-1">
            <span className="text-sm">{d.folder_new}</span>
            <input name="name" maxLength={60} required className={inputClass} />
          </label>
          <PendingButton pending={dict.owner.saving}>{d.folder_create}</PendingButton>
        </form>
      )}

      <h3 className="pt-2 font-semibold">{d.documents_title}</h3>
      {docs.length === 0 && <p className="text-sm text-muted">{d.no_documents}</p>}
      {docs.map((doc) => {
        const docPictures = pictures.filter((p) => p.document_id === doc.id);
        return (
          <article key={doc.id} className="flex flex-col gap-2 border border-line p-3 text-sm">
            <div className="flex flex-col">
              <span className="font-semibold">{doc.name}</span>
              {doc.description && <span>{doc.description}</span>}
            </div>
            <p className="text-muted">
              {[
                folderName(doc.folder_id),
                t(d.pages, { n: doc.pages }),
                languageName(doc.lang, lang),
                t(d.uploaded, { date: date(doc.created_at) }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <p>
              <span className="font-semibold">{d[`status_${doc.status}`]}</span>
              {doc.status === "error" && doc.error ? ` – ${doc.error}` : ""}
            </p>
            <p>
              {doc.assistant_enabled ? d.assistant_on : d.assistant_off} · {doc.downloadable ? d.download_on : d.download_off}
            </p>
            {doc.status !== "uploading" && (
              <a href={ownerFileUrl("document", doc.id)} target="_blank" rel="noopener" className="self-start underline underline-offset-4">
                {d.open}
              </a>
            )}
            <details>
              <summary className="cursor-pointer underline underline-offset-4">{d.change}</summary>
              <form action={saveDocument} className="mt-2 flex flex-col gap-2">
                {hidden({ document_id: doc.id })}
                <label className="flex flex-col gap-1">
                  <span>{d.name}</span>
                  <input name="name" defaultValue={doc.name} maxLength={200} required className={inputClass} />
                </label>
                <label className="flex flex-col gap-1">
                  <span>{d.description}</span>
                  <textarea name="description" defaultValue={doc.description ?? ""} maxLength={500} rows={2} className={inputClass} />
                </label>
                <FolderField options={options} value={doc.folder_id} label={d.folder} />
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="assistant" defaultChecked={doc.assistant_enabled} />
                  {d.assistant_may_use}
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="download" defaultChecked={doc.downloadable} />
                  {d.shoppers_may_download}
                </label>
                <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>
              </form>
            </details>
            {docPictures.length > 0 && (
              <details>
                <summary className="cursor-pointer underline underline-offset-4">{t(d.pdf_pictures, { n: docPictures.length })}</summary>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {docPictures.map((p) => (
                    <PictureCard key={p.id} picture={p} url={links?.pictures[p.id]} source={t(d.from_page, { name: doc.name, page: p.page ?? 1 })} options={null} d={d} dict={dict} hidden={hidden} />
                  ))}
                </div>
              </details>
            )}
            <form action={deleteDocOrPicture} className="flex flex-wrap items-center gap-2">
              {hidden({ kind: "document", id: doc.id })}
              <label className="flex items-center gap-2">
                <input type="checkbox" name="confirm" required />
                {d.delete_confirm}
              </label>
              <PendingButton pending={d.deleting}>{d.delete}</PendingButton>
            </form>
          </article>
        );
      })}

      <h3 className="pt-2 font-semibold">{d.pictures_title}</h3>
      {ownPictures.length === 0 && <p className="text-sm text-muted">{d.no_pictures}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {ownPictures.map((p) => (
          <PictureCard key={p.id} picture={p} url={links?.pictures[p.id]} source={folderName(p.folder_id)} options={options} d={d} dict={dict} hidden={hidden} />
        ))}
      </div>

      <h3 className="pt-2 font-semibold">{d.keys_title}</h3>
      <p className="text-sm">{d.keys_intro}</p>
      {keys.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm">
          {keys.map((k) => {
            const expired = isPast(k.expires_at);
            const state = k.revoked_at ? d.key_revoked : expired ? d.key_expired : d.key_active;
            return (
              <li key={k.id} className="flex flex-col gap-1 border-b border-line pb-2">
                <span>
                  <span className="font-medium">{k.label}</span> · <span className="font-semibold">{state}</span>
                </span>
                <span className="text-muted">
                  {t(d.key_opens, { folders: k.folder_ids.map(folderName).join(", ") })}
                </span>
                <span className="text-muted">
                  {[
                    t(d.key_created, { date: date(k.created_at) }),
                    k.expires_at ? t(d.key_expires_on, { date: date(k.expires_at) }) : d.key_no_expiry,
                    t(d.key_last_used, {
                      date: k.last_used_at ? formatDateTime(k.last_used_at, lang, shop.timezone) : dict.account.never,
                    }),
                    t(d.key_uses, { n: k.use_count }),
                  ].join(" · ")}
                </span>
                {!k.revoked_at && (
                  <form action={revokeFolderKey}>
                    {hidden({ key_id: k.id })}
                    <button type="submit" className="underline underline-offset-4">{d.key_revoke}</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hasPlan && termsAccepted && privateFolders.length > 0 ? (
        <FolderKeyForm
          action={createFolderKey}
          shopId={shop.id}
          timeZone={shop.timezone}
          folders={privateFolders.map((f) => ({ id: f.id, name: f.name }))}
          labels={d}
        />
      ) : (
        hasPlan && <p className="text-sm text-muted">{d.keys_need_folder}</p>
      )}
    </>
  );
}

function FolderField({ options, value, label }: { options: FolderOption[]; value: string; label: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span>{label}</span>
      <select name="folder" defaultValue={value} className={`${inputClass} bg-white`}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** One picture: thumbnail, the owner's title and caption, the AI's description (the owner may correct it). */
function PictureCard({
  picture,
  url,
  source,
  options,
  d,
  dict,
  hidden,
}: {
  picture: Picture;
  url: string | undefined;
  source: string;
  /** Folders to move an own picture to; null for pictures from a PDF (they stay with it). */
  options: FolderOption[] | null;
  d: Dictionary["docs"];
  dict: Dictionary;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
}) {
  const waiting = picture.status === "pending" || picture.status === "working";
  return (
    <div className="flex flex-col gap-2 border border-line p-2 text-sm">
      <div className="flex gap-3">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed address from private storage
          <img src={url} alt={picture.title || source} className="h-24 w-24 shrink-0 border border-line object-contain" />
        ) : (
          <span className="h-24 w-24 shrink-0 border border-line" />
        )}
        <div className="flex min-w-0 flex-col">
          {picture.title && <span className="font-medium">{picture.title}</span>}
          <span className="text-muted">{source}</span>
          <span className="font-semibold">{picture.show ? d.show_on : d.show_off}</span>
          {waiting && <span>{d.picture_waiting}</span>}
          {picture.status === "error" && <span>{d.picture_error}</span>}
        </div>
      </div>
      <details>
        <summary className="cursor-pointer underline underline-offset-4">{d.picture_change}</summary>
        <form action={savePicture} className="mt-2 flex flex-col gap-2">
          {hidden({ picture_id: picture.id })}
          <label className="flex flex-col gap-1">
            <span>{d.picture_title}</span>
            <input name="title" defaultValue={picture.title} maxLength={200} className={inputClass} />
          </label>
          {options && (
            <label className="flex flex-col gap-1">
              <span>{d.caption}</span>
              <textarea name="caption" defaultValue={picture.caption ?? ""} maxLength={500} rows={2} className={inputClass} />
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span>
              {d.ai_description}
              {picture.description_by_owner && <span className="text-muted"> · {d.corrected_by_you}</span>}
            </span>
            <textarea name="description" defaultValue={picture.description ?? ""} maxLength={2000} rows={3} className={inputClass} />
          </label>
          {options && <FolderField options={options} value={picture.folder_id} label={d.folder} />}
          <label className="flex items-center gap-2">
            <input type="checkbox" name="show" defaultChecked={picture.show} />
            {d.assistant_may_show}
          </label>
          <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>
        </form>
      </details>
      {options && (
        <form action={deleteDocOrPicture}>
          {hidden({ kind: "picture", id: picture.id })}
          <button type="submit" className="underline underline-offset-4">{d.delete}</button>
        </form>
      )}
    </div>
  );
}
