import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("veDesktop", {
  platform: process.platform,
  follow: {
    open: async (detail = {}) => {
      return ipcRenderer.invoke("bosun:desktop:follow:open", detail || {});
    },
    hide: async () => {
      return ipcRenderer.invoke("bosun:desktop:follow:hide");
    },
    restore: async () => {
      return ipcRenderer.invoke("bosun:desktop:follow:restore");
    },
  },
});
