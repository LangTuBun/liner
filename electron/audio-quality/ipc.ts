import { ipcMain } from "electron";
import { getOutputEndpoints } from "./endpoints.js";

export function setupAudioQuality() {
  ipcMain.handle("audio-quality:endpoints", () =>
    getOutputEndpoints().catch(() => ({ supported: false, endpoints: [] })),
  );
}
