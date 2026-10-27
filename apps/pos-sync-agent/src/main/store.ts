import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { Config, Binding, Batch } from "../core/model";
export type State = {
  config?: Config;
  binding?: Binding;
  file?: string;
  paused: boolean;
  queue: (Batch & { mappingVersion: string })[];
  lastId?: string;
  lastTime?: string;
};
interface CryptoStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export class Store {
  private unreadable = false;
  private writing: Promise<void> = Promise.resolve();
  state: State = { paused: true, queue: [] };
  constructor(
    private dir: string,
    private crypto: CryptoStorage,
  ) {}
  available() {
    return (
      !this.unreadable &&
      this.crypto.isEncryptionAvailable() &&
      this.crypto.getSelectedStorageBackend?.() !== "basic_text"
    );
  }
  async load() {
    try {
      const bytes = await readFile(path.join(this.dir, "state.enc"));
      if (!this.available()) throw Error("SECURE_STORAGE_REQUIRED");
      this.state = JSON.parse(this.crypto.decryptString(bytes));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        this.unreadable = true;
        throw e;
      }
    }
  }
  async save() {
    if (!this.available()) throw Error("SECURE_STORAGE_REQUIRED");
    const encrypted = this.crypto.encryptString(JSON.stringify(this.state));
    const write = async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const target = path.join(this.dir, "state.enc");
      await writeFile(target + ".tmp", encrypted, { mode: 0o600 });
      await rename(target + ".tmp", target);
    };
    this.writing = this.writing.then(write, write);
    await this.writing;
  }
}
