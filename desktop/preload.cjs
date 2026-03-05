const { contextBridge, ipcRenderer } = require("electron");

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

  shortcuts: {
    list: () => ipcRenderer.invoke("bosun:shortcuts:list"),
    set: (id, accelerator) =>
      ipcRenderer.invoke("bosun:shortcuts:set", { id, accelerator }),
    reset: (id) => ipcRenderer.invoke("bosun:shortcuts:reset", { id }),
    resetAll: () => ipcRenderer.invoke("bosun:shortcuts:resetAll"),
    showDialog: () => ipcRenderer.invoke("bosun:shortcuts:showDialog"),
  },
});
