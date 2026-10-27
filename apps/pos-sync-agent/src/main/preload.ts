import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("connector", {
  settings: () => ipcRenderer.invoke("connector", "settings"),
  invoke: (action: string, value?: unknown) =>
    ipcRenderer.invoke("connector", action, value),
  onState: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("state", handler);
    return () => ipcRenderer.removeListener("state", handler);
  },
});
