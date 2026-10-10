"use client";

import { useActionState, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import type { KeyState } from "@/app/[lang]/(account)/dashboard/docActions";

type Labels = Dictionary["docs"];

/**
 * "Nastaviť kľúč" / "Zmeniť kľúč" of one private folder: the new key is shown here once, with
 * "Kopírovať"; only its hash is kept, and the folder's previous key stops at once.
 */
export function FolderKeySetter({
  action,
  folderId,
  folderName,
  hasKey,
  labels,
}: {
  action: (previous: KeyState, formData: FormData) => Promise<KeyState>;
  folderId: string;
  folderName: string;
  hasKey: boolean;
  labels: Labels;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2" data-folder-key={folderName}>
      {state.key && (
        <div className="flex flex-col gap-2 border border-foreground p-3" role="status">
          <span>{labels.folder_key_once.replace("{name}", folderName)}</span>
          <code className="select-all break-all text-lg font-semibold tracking-wider" data-new-key>
            {state.key}
          </code>
          <button
            type="button"
            className="self-start rounded border border-line px-3 py-1"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(state.key!);
                setCopied(state.key!);
              } catch {
                setCopied("");
              }
            }}
          >
            {copied === state.key ? labels.copied : copied === "" ? labels.copy_failed : labels.copy}
          </button>
        </div>
      )}
      {state.error && <p className="border border-line p-2">{state.error}</p>}
      <form
        action={formAction}
        onSubmit={(event) => {
          if ((hasKey || state.key) && !window.confirm(labels.folder_key_change_confirm)) event.preventDefault();
        }}
      >
        <input type="hidden" name="folder_id" value={folderId} />
        <input type="hidden" name="folder_name" value={folderName} />
        <button type="submit" disabled={pending} className="rounded border border-line px-3 py-1 disabled:text-muted">
          {pending ? labels.saving : hasKey || state.key ? labels.folder_key_change : labels.folder_key_set}
        </button>
      </form>
    </div>
  );
}
