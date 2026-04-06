import { contextBridge } from "electron";

/** Reserved for future IPC; keep preload minimal. */
contextBridge.exposeInMainWorld("electronApp", {
  platform: process.platform,
});
