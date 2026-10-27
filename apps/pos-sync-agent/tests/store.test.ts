import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/main/store";
// Injected fake cipher tests persistence behavior only, never claims OS keychain validation.
const crypto = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "test",
  encryptString: (v: string) => Buffer.from("test:" + v),
  decryptString: (v: Buffer) => {
    const s = v.toString();
    if (!s.startsWith("test:")) throw Error("bad ciphertext");
    return s.slice(5);
  },
};
test("durable state survives restart and overlapping saves finish in call order", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "connector-store-"));
  try {
    const s = new Store(dir, crypto);
    s.state.lastId = "first";
    const first = s.save();
    s.state.lastId = "second";
    const second = s.save();
    await Promise.all([first, second]);
    const restored = new Store(dir, crypto);
    await restored.load();
    assert.equal(restored.state.lastId, "second");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("unavailable or plaintext storage refuses to persist credentials", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "connector-store-"));
  try {
    for (const encryption of [
      { ...crypto, isEncryptionAvailable: () => false },
      { ...crypto, getSelectedStorageBackend: () => "basic_text" },
    ]) {
      const s = new Store(dir, encryption);
      assert(!s.available());
      await assert.rejects(s.save(), /SECURE_STORAGE_REQUIRED/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("unreadable encrypted state is preserved and cannot be overwritten", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "connector-store-"));
  try {
    const file = path.join(dir, "state.enc");
    await writeFile(file, "unreadable original");
    const s = new Store(dir, crypto);
    await assert.rejects(s.load());
    await assert.rejects(s.save(), /SECURE_STORAGE_REQUIRED/);
    assert.equal(await readFile(file, "utf8"), "unreadable original");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
