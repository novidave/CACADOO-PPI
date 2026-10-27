import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Tray,
  Menu,
  nativeImage,
  safeStorage,
} from "electron";
import { open, stat, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { en } from "../renderer/messages";
import { pathToFileURL } from "node:url";
import { Store } from "./store";
import { configSchema, assertHttps, MAX_BYTES } from "../core/model";
import { parseFile, snapshot } from "../core/snapshot";
import { pair, status, upload as sendUpload } from "../core/api";
import { restSnapshot } from "../core/network";
let window: BrowserWindow, store: Store, tray: Tray;
let commandBusy = false;
let busy = false,
  quitting = false,
  nextCheck = 0,
  message = "PAUSED";
function view() {
  const c = store.state.config;
  return {
    configured: !!c,
    paired: !!store.state.binding,
    secure: store.available(),
    paused: store.state.paused,
    busy,
    message,
    queued: store.state.queue.length,
    lastTime: store.state.lastTime ?? null,
    file: store.state.file ? path.basename(store.state.file) : null,
    source: c?.kind ?? null,
    shop: store.state.binding?.shopId ?? null,
  };
}
function publish() {
  window?.webContents.send("state", view());
}
const errorCode = (e: unknown) =>
  e instanceof Error && /^[A-Z][A-Z_0-9]+$/.test(e.message)
    ? e.message
    : "OPERATION_FAILED";
async function stableFile() {
  const file = store.state.file;
  if (!file) throw Error("CHOOSE_FILE");
  if ((await lstat(file)).isSymbolicLink() || (await realpath(file)) !== file)
    throw Error("SYMLINK_DENIED");
  const before = await stat(file);
  if (!before.isFile() || !before.size || before.size > MAX_BYTES)
    throw Error("FILE_SIZE");
  if (Date.now() - before.mtimeMs < 60000) throw Error("FILE_SETTLING");
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size
    )
      throw Error("FILE_CHANGED");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== before.size) throw Error("FILE_CHANGED");
    bytes = buffer.subarray(0, length);
    const after = await handle.stat();
    const current = await stat(file);
    if (
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size ||
      current.ino !== after.ino ||
      (await realpath(file)) !== file
    )
      throw Error("FILE_CHANGED");
  } finally {
    await handle.close();
  }
  return {
    rows: await parseFile(bytes, file),
    time: new Date(before.mtimeMs).toISOString(),
  };
}
async function sync(fromCommand = false) {
  if (busy || (commandBusy && !fromCommand) || store.state.paused) return;
  busy = true;
  publish();
  try {
    const { binding, config } = store.state;
    if (!binding || !config) throw Error("PAIR_FIRST");
    if (Date.parse(binding.expiresAt) <= Date.now())
      throw Error("PAIR_EXPIRED");
    const server = await status(config.backend, binding);
    if (!server.active || server.generation !== binding.generation)
      throw Error("SOURCE_NOT_ACTIVE");
    if (!server.mappingApproved) throw Error("MAPPING_NOT_APPROVED");
    // Recheck authority BEFORE acquisition and every retry. Do not silently drop expired queued data.
    if (
      store.state.queue.some(
        (x) => Date.now() - x.createdAt > 24 * 60 * 60 * 1000,
      )
    )
      throw Error("QUEUE_EXPIRED");
    if (!store.state.queue.length) {
      const source =
        config.kind === "file"
          ? await stableFile()
          : await restSnapshot(config);
      const batch = snapshot(
        source.rows,
        config,
        source.time,
        binding.generation,
      );
      if (batch.id === store.state.lastId) {
        message = "UNCHANGED";
        return;
      }
      if (
        server.latestSourceTime &&
        Date.parse(batch.sourceTimestamp) <= Date.parse(server.latestSourceTime)
      ) {
        message = "UNCHANGED";
        return;
      }
      store.state.queue.push({
        ...batch,
        mappingVersion: server.mappingVersion,
      });
      await store.save();
    }
    const batch = store.state.queue[0];
    if (batch.generation !== binding.generation)
      throw Error("SOURCE_NOT_ACTIVE");
    if (
      server.latestSourceTime &&
      Date.parse(server.latestSourceTime) > Date.parse(batch.sourceTimestamp)
    )
      throw Error("SOURCE_NOT_ACTIVE");
    if (batch.mappingVersion !== server.mappingVersion)
      throw Error("MAPPING_NOT_APPROVED");
    if (batch.nextAt > Date.now()) {
      message = "RETRY_WAIT";
      return;
    }
    try {
      await sendUpload(config.backend, binding, batch, server.mappingVersion);
    } catch (e) {
      batch.attempts++;
      batch.nextAt =
        Date.now() +
        Math.min(6 * 60 * 60 * 1000, 30000 * 2 ** Math.min(batch.attempts, 10));
      if (batch.attempts >= 20) store.state.paused = true;
      await store.save();
      throw e;
    }
    store.state.queue.shift();
    store.state.lastId = batch.id;
    store.state.lastTime = batch.sourceTimestamp;
    await store.save();
    message = "UPDATED";
  } catch (e) {
    message = errorCode(e);
    if (
      ![
        "HTTP_429",
        "HTTP_500",
        "HTTP_502",
        "HTTP_503",
        "HTTP_504",
        "OPERATION_FAILED",
        "REQUEST_TIMEOUT",
        "FILE_SETTLING",
        "FILE_CHANGED",
      ].includes(message)
    ) {
      store.state.paused = true;
      await store.save().catch(() => {});
    }
  } finally {
    busy = false;
    publish();
  }
}
function setupIpc() {
  ipcMain.handle("connector", async (event, action: string, value: unknown) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame?.url !==
        pathToFileURL(path.join(__dirname, "renderer/index.html")).href
    )
      throw Error("IPC_DENIED");
    let acquired = false;
    try {
      if (action === "state") return view();
      if (action === "settings") {
        const c = store.state.config;
        return c
          ? { ...c, rest: c.rest ? { ...c.rest, token: undefined } : undefined }
          : null;
      }
      if (busy || commandBusy) throw Error("BUSY");
      commandBusy = true;
      acquired = true;
      switch (action) {
        case "configure": {
          if (store.state.queue.length) throw Error("CLEAR_QUEUE_FIRST");
          const config = configSchema.parse(value);
          assertHttps(config.backend);
          if (
            new URL(config.backend).origin !== config.backend.replace(/\/$/, "")
          )
            throw Error("BACKEND_ORIGIN_REQUIRED");
          if (config.kind === "rest" && !config.rest)
            throw Error("REST_REQUIRED");
          store.state.binding = undefined;
          store.state.config = config;
          store.state.lastId = undefined;
          store.state.paused = true;
          message = "CONFIGURED";
          break;
        }
        case "choose": {
          if (store.state.queue.length) throw Error("CLEAR_QUEUE_FIRST");
          store.state.paused = true;
          const result = await dialog.showOpenDialog(window, {
            properties: ["openFile"],
            filters: [
              { name: en.stockFile, extensions: ["csv", "txt", "xml", "xlsx"] },
            ],
          });
          if (!result.canceled) {
            store.state.file = await realpath(result.filePaths[0]);
            store.state.lastId = undefined;
            store.state.binding = undefined;
          }
          break;
        }
        case "pair": {
          if (!store.state.config) throw Error("CONFIGURE_FIRST");
          if (
            typeof value !== "string" ||
            value.length < 4 ||
            value.length > 100
          )
            throw Error("PAIR_CODE");
          if (!store.available()) throw Error("SECURE_STORAGE_REQUIRED");
          if (store.state.queue.length) throw Error("CLEAR_QUEUE_FIRST");
          const binding = await pair(store.state.config.backend, value);
          store.state.binding = binding;
          store.state.paused = true;
          message = "PAIRED";
          break;
        }
        case "inspect": {
          if (!store.state.config) throw Error("CONFIGURE_FIRST");
          const source = await stableFile();
          const batch = snapshot(
            source.rows,
            store.state.config,
            source.time,
            0,
          );
          message = "VALIDATED";
          return { ...view(), validation: { rows: batch.rows } };
        }
        case "sync":
          store.state.paused = false;
          await store.save();
          await sync(true);
          return view();
        case "pause":
          store.state.paused = true;
          message = "PAUSED";
          break;
        case "clear": {
          const choice = await dialog.showMessageBox(window, {
            type: "warning",
            message: en.discardPrompt,
            buttons: [en.cancel, en.disconnect],
            defaultId: 0,
            cancelId: 0,
          });
          if (choice.response === 1) {
            store.state = {
              paused: true,
              queue: [],
              config: store.state.config,
              file: store.state.file,
            };
            message = "DISCONNECTED";
          }
          break;
        }
        case "startup":
          app.setLoginItemSettings({ openAtLogin: value === true });
          break;
        default:
          throw Error("IPC_DENIED");
      }
      await store.save();
      publish();
      return view();
    } catch (e) {
      message = errorCode(e);
      publish();
      return view();
    } finally {
      if (acquired) commandBusy = false;
    }
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  void app.whenReady().then(async () => {
    store = new Store(
      path.join(app.getPath("userData"), "connector"),
      safeStorage,
    );
    try {
      await store.load();
    } catch {
      message = "SECURE_STORAGE_REQUIRED";
    }
    // A restart never silently starts uploads; the owner resumes explicitly.
    store.state.paused = true;
    window = new BrowserWindow({
      width: 870,
      height: 900,
      minWidth: 600,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (e) => e.preventDefault());
    window.on("close", (e) => {
      if (!quitting) {
        e.preventDefault();
        window.hide();
      }
    });
    setupIpc();
    await window.loadFile(path.join(__dirname, "renderer/index.html"));
    tray = new Tray(
      nativeImage.createFromPath(
        path.join(app.getAppPath(), "assets/tray.png"),
      ),
    );
    tray.setToolTip("Cacaduu Connector");
    tray.on("click", () => window.show());
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Cacaduu Connector", click: () => window.show() },
        {
          label: en.pause,
          click: () => {
            store.state.paused = true;
            message = "PAUSED";
            void store.save().catch(() => {
              message = "SECURE_STORAGE_REQUIRED";
              publish();
            });
            publish();
          },
        },
        { label: en.quit, click: () => app.quit() },
      ]),
    );
    setInterval(() => {
      if (!store.state.paused && Date.now() >= nextCheck) {
        nextCheck =
          Date.now() + (store.state.config?.intervalMinutes ?? 15) * 60000;
        void sync();
      }
    }, 10000);
  });
}
