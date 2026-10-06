import type { Dictionary } from "@/i18n/dictionaries";
import type { FolderSyncLabels } from "@/components/FolderSync";

/** The texts the folder-sync box needs (it runs in the browser, so it gets plain strings). */
export function folderSyncLabels(dict: Dictionary): FolderSyncLabels {
  return {
    ...dict.sync,
    latest_file: dict.dashboard.latest_file,
    never: dict.account.never,
    state_current: dict.account.state_current,
    state_recent: dict.account.state_recent,
    state_stale: dict.account.state_stale,
  };
}
