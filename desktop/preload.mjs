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

  /**
   * Navigate the main window to a SPA route.
   * Useful when renderer code needs to trigger navigation programmatically.
   * @param {string} path  e.g. "/chat", "/tasks", "/settings"
   * @returns {Promise<{ ok: boolean }>}
   */
  navigate: (path) =>
    ipcRenderer.invoke("bosun:navigate", { path: String(path || "/") }),

  /**
   * Workspace management API.
   * Available in the renderer via `window.veDesktop.workspaces.*`
   */
  workspaces: {
    /**
     * Returns the cached workspace list and currently active workspace ID.
     * @returns {Promise<{ ok: boolean, workspaces: object[], activeId: string|null }>}
     */
    list: () => ipcRenderer.invoke("bosun:workspaces:list"),

    /**
     * Switch the active workspace.
     * @param {string} workspaceId
     * @returns {Promise<{ ok: boolean, activeId: string }>}
     */
    switch: (workspaceId) =>
      ipcRenderer.invoke("bosun:workspaces:switch", { workspaceId }),
  },

  /**
   * Keyboard shortcuts API.
   * Available in the renderer via `window.veDesktop.shortcuts.*`
   */
  shortcuts: {
    /**
     * Returns the full shortcuts catalog with current effective accelerators.
     * @returns {Promise<ShortcutEntry[]>}
     */
    list: () => ipcRenderer.invoke("bosun:shortcuts:list"),

    /**
     * Set a custom accelerator for a shortcut.
     * Pass `null` as accelerator to disable the shortcut.
     * @param {string} id
     * @param {string|null} accelerator  Electron accelerator string or null.
     * @returns {Promise<{ ok: boolean, error?: string }>}
     */
    set: (id, accelerator) =>
      ipcRenderer.invoke("bosun:shortcuts:set", { id, accelerator }),

    /**
     * Reset a single shortcut to its default accelerator.
     * @param {string} id
     * @returns {Promise<{ ok: boolean, error?: string }>}
     */
    reset: (id) => ipcRenderer.invoke("bosun:shortcuts:reset", { id }),

    /**
     * Reset all shortcuts to their defaults.
     * @returns {Promise<{ ok: boolean }>}
     */
    resetAll: () => ipcRenderer.invoke("bosun:shortcuts:resetAll"),

    /**
     * Show the native keyboard shortcuts reference dialog.
     * @returns {Promise<{ ok: boolean }>}
     */
    showDialog: () => ipcRenderer.invoke("bosun:shortcuts:showDialog"),

    /**
     * Enable or disable global (system-wide) firing for a globalEligible shortcut.
     * Has no effect on built-in global shortcuts (bosun.focus, bosun.quickchat).
     * @param {string}  id       Shortcut ID.
     * @param {boolean} isGlobal true to fire from anywhere, false for focused-only.
     * @returns {Promise<{ ok: boolean, error?: string }>}
     */
    setScope: (id, isGlobal) =>
      ipcRenderer.invoke("bosun:shortcuts:setScope", { id, isGlobal }),
  },
});
