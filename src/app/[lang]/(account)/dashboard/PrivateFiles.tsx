import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { formatDate } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { PendingButton } from "@/components/PendingButton";
import { deleteDocOrPicture } from "./docActions";
import { keyActive, ownerFileUrl, type ShopDocsData } from "./ShopDocuments";

/** A PDF or an own picture in one of the shop's private folders (pictures from a PDF stay with it). */
export interface PrivateFile {
  kind: "document" | "picture";
  id: string;
  name: string;
  created_at: string;
  status: string;
  folder: string;
  /** A valid access key (not revoked, not expired) opens the file's folder. */
  key: boolean;
}

/** The files of the private folders, newest first, from the data of "Documents for the assistant". */
export function privateFiles(data: ShopDocsData | null): PrivateFile[] {
  if (!data) return [];
  const folders = new Map(data.folders.filter((f) => !f.is_public).map((f) => [f.id, f.name]));
  const keyed = new Set(data.keys.filter(keyActive).flatMap((k) => k.folder_ids));
  const file = (kind: PrivateFile["kind"], id: string, name: string, createdAt: string, status: string, folderId: string) => ({
    kind,
    id,
    name,
    created_at: createdAt,
    status,
    folder: folders.get(folderId) ?? "–",
    key: keyed.has(folderId),
  });
  return [
    ...data.docs.filter((d) => folders.has(d.folder_id)).map((d) => file("document", d.id, d.name, d.created_at, d.status, d.folder_id)),
    ...data.pictures
      .filter((p) => !p.document_id && folders.has(p.folder_id))
      .map((p) => file("picture", p.id, p.title, p.created_at, p.status, p.folder_id)),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Under "Export folder": the files of the shop's private folders, for the owner only (RLS:
 * only the shop's members read them). Open = a 10-minute signed address; delete as in
 * "Documents for the assistant".
 */
export function PrivateFiles({
  files,
  shop,
  lang,
  dict,
  notice,
}: {
  files: PrivateFile[];
  shop: MyShop;
  lang: Locale;
  dict: Dictionary;
  notice: React.ReactNode;
}) {
  const d = dict.docs;
  const p = dict.dashboard;
  const hidden = (extra: Record<string, string>) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="shop_id" value={shop.id} />
      <input type="hidden" name="shop_slug" value={shop.slug} />
      <input type="hidden" name="at" value="private" />
      {Object.entries(extra).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
  return (
    <>
      {notice}
      <p className="text-sm">{p.private_intro}</p>
      {files.length === 0 ? (
        <p className="text-sm text-muted">{p.private_none}</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line text-sm">
          {files.map((f) => (
            <li key={f.id} className="flex flex-col gap-1 py-2" data-private-file={f.kind}>
              <span className="break-words font-medium">{f.name || p.private_picture}</span>
              <span className="text-muted">
                {[
                  f.kind === "document" ? p.private_pdf : p.private_picture,
                  t(d.uploaded, { date: formatDate(f.created_at, lang, shop.timezone) }),
                  t(p.private_folder, { folder: f.folder }),
                ].join(" · ")}
              </span>
              <span>
                {p.private_key}: <span className="font-semibold">{f.key ? p.private_key_on : p.private_key_off}</span>
              </span>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {f.status !== "uploading" && (
                  <a href={ownerFileUrl(f.kind, f.id)} target="_blank" rel="noopener" className="underline underline-offset-4">
                    {d.open}
                  </a>
                )}
                <form action={deleteDocOrPicture} className="flex flex-wrap items-center gap-2">
                  {hidden({ kind: f.kind, id: f.id })}
                  {f.kind === "document" && (
                    <label className="flex items-center gap-2">
                      <input type="checkbox" name="confirm" required />
                      {d.delete_confirm}
                    </label>
                  )}
                  <PendingButton pending={d.deleting}>{d.delete}</PendingButton>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
