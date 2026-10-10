"use client";

import { useState, useTransition } from "react";
import type { FolderList } from "@/app/[lang]/(account)/dashboard/cloudActions";
import { PendingButton } from "@/components/PendingButton";

export interface CloudFolderLabels {
  folder: string;
  folder_hint: string;
  folder_path: string;
  folder_save: string;
  browse: string;
  folder_up: string;
  folder_empty: string;
  folder_loading: string;
  folder_failed: string;
  folder_new: string;
  folder_create: string;
  folder_use: string;
  saving: string;
  errors: Record<string, string>;
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/**
 * The target folder of the shop's cloud: typed as a path, or picked by browsing the
 * connected OneDrive / Dropbox (folders only; a new one can be made). Saving goes through
 * the server action, which asks the cloud-export function with the owner's login.
 */
export function CloudFolderPicker({
  shopId,
  folder,
  hidden,
  labels,
  save,
  browse,
  create,
}: {
  shopId: string;
  folder: string;
  hidden: Record<string, string>;
  labels: CloudFolderLabels;
  save: (formData: FormData) => Promise<void>;
  browse: (shopId: string, path: string) => Promise<FolderList>;
  create: (shopId: string, path: string, name: string) => Promise<{ path: string } | { error: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(folder);
  const [folders, setFolders] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [loading, startLoading] = useTransition();

  const errorText = (code: string) => labels.errors[code] ?? labels.folder_failed;

  const show = (target: string, fallback = false): void =>
    startLoading(async () => {
      setError(null);
      let result = await browse(shopId, target);
      // A folder that does not exist yet: start from the top of the cloud instead.
      if ("error" in result && fallback && target !== "/" && result.error === "folder") result = await browse(shopId, "/");
      if ("error" in result) {
        setError(errorText(result.error));
        return;
      }
      setPath(result.path);
      setFolders(result.folders);
    });

  const makeFolder = () =>
    startLoading(async () => {
      if (!name.trim()) return;
      setError(null);
      const result = await create(shopId, path, name);
      if ("error" in result) {
        setError(errorText(result.error));
        return;
      }
      setName("");
      const listed = await browse(shopId, result.path);
      if ("error" in listed) {
        setError(errorText(listed.error));
        return;
      }
      setPath(listed.path);
      setFolders(listed.folders);
    });

  const inputs = Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);
  const input = "min-w-0 flex-1 rounded border border-line px-3 py-2 outline-none focus:border-foreground";

  return (
    <div className="flex flex-col gap-3" data-cloud-folder>
      <form action={save} className="flex flex-col gap-2">
        {inputs}
        <label className="flex flex-col gap-1">
          <span className="text-sm">{labels.folder_path}</span>
          <span className="flex flex-wrap gap-2">
            <input name="folder" defaultValue={folder} maxLength={400} required className={input} />
            <PendingButton pending={labels.saving}>{labels.folder_save}</PendingButton>
          </span>
        </label>
        <span className="text-xs text-muted">{labels.folder_hint}</span>
      </form>

      {!open ? (
        <button
          type="button"
          className="self-start text-sm underline underline-offset-4"
          onClick={() => {
            setOpen(true);
            show(folder, true);
          }}
        >
          {labels.browse}
        </button>
      ) : (
        <div className="flex flex-col gap-2 border border-line p-3" data-cloud-browser>
          <p className="break-all text-sm font-semibold" data-cloud-path>
            {path}
          </p>
          {path !== "/" && (
            <button type="button" className="self-start text-sm underline underline-offset-4" disabled={loading} onClick={() => show(parentOf(path))}>
              {labels.folder_up}
            </button>
          )}
          {loading ? (
            <p className="text-sm text-muted" role="status">
              {labels.folder_loading}
            </p>
          ) : folders && folders.length > 0 ? (
            <ul className="flex flex-col divide-y divide-line border-y border-line text-sm">
              {folders.map((f) => (
                <li key={f}>
                  <button
                    type="button"
                    className="w-full break-all py-2 text-left hover:underline"
                    onClick={() => show(path === "/" ? `/${f}` : `${path}/${f}`)}
                  >
                    {f}/
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            folders && <p className="text-sm text-muted">{labels.folder_empty}</p>
          )}
          {error && (
            <p className="border border-line p-2 text-sm" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-40 flex-1 flex-col gap-1">
              <span className="text-sm">{labels.folder_new}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={input} />
            </label>
            <button type="button" className="rounded border border-line px-4 py-2" disabled={loading || !name.trim()} onClick={makeFolder}>
              {labels.folder_create}
            </button>
          </div>
          {path !== "/" && (
            <form action={save}>
              {inputs}
              <input type="hidden" name="folder" value={path} />
              <PendingButton pending={labels.saving}>{labels.folder_use}</PendingButton>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
