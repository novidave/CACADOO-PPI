/**
 * Browser-only storage for the shop PC's folder connection (IndexedDB), used by
 * the /sync page: the folder handle the owner picked (browsers can store it, so
 * the folder is remembered) and the last file sent, per shop.
 */

const DB_NAME = "ppi-folder";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export const storeGet = <T>(key: string) => run<T | undefined>("readonly", (s) => s.get(key));
export const storeSet = (key: string, value: unknown) => run<IDBValidKey>("readwrite", (s) => s.put(value, key));
export const storeDelete = (key: string) => run<undefined>("readwrite", (s) => s.delete(key));

// ---- File System Access API (Edge and Chrome on a computer; not in Firefox or Safari)

export type ReadPermission = "granted" | "denied" | "prompt";

export interface FolderFile {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}

export interface FolderHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterable<FolderFile | { kind: "directory"; name: string }>;
  queryPermission(options: { mode: "read" }): Promise<ReadPermission>;
  requestPermission(options: { mode: "read" }): Promise<ReadPermission>;
}

type PickerWindow = Window & {
  showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite"; startIn?: string }) => Promise<FolderHandle>;
};

export function folderPickerSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as PickerWindow).showDirectoryPicker === "function";
}

export function pickFolder(): Promise<FolderHandle> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return Promise.reject(new Error("Folder picker not supported"));
  return picker.call(window, { id: "ppi-export", mode: "read", startIn: "documents" });
}

/** Stock files the stock-pull function can read (old binary .xls is not one of them). */
const STOCK_FILE = /\.(xml|csv|txt|xlsx)$/i;

/** The most recently written stock file directly in the folder (subfolders are ignored). */
export async function newestStockFile(folder: FolderHandle): Promise<{ handle: FolderFile; file: File } | null> {
  let newest: { handle: FolderFile; file: File } | null = null;
  for await (const entry of folder.values()) {
    if (entry.kind !== "file" || !STOCK_FILE.test(entry.name) || entry.name.startsWith("~$") || entry.name.startsWith(".")) {
      continue;
    }
    try {
      const file = await entry.getFile();
      if (!newest || file.lastModified > newest.file.lastModified) newest = { handle: entry, file };
    } catch {
      // being written or locked right now: the next check picks it up
    }
  }
  return newest;
}

/** gzip in the browser when available (stock files shrink about 10×). */
export async function compress(data: ArrayBuffer): Promise<{ body: Blob; gzip: boolean }> {
  if (typeof CompressionStream === "undefined") return { body: new Blob([data]), gzip: false };
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
  return { body: await new Response(stream).blob(), gzip: true };
}
