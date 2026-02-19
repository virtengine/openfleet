import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("veDesktop", {
  platform: process.platform,
});
