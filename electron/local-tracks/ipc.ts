import path from "node:path";
import { BrowserWindow, app, dialog, ipcMain } from "electron";
import { LocalTrackLibrary } from "./library.js";
import { probeLocalAudio } from "./metadata.js";
import { handleLocalTrackScheme } from "./protocol.js";
import type { SavedTrackLibrary } from "../saved-tracks/library.js";
import { LOCAL_AUDIO_EXTENSIONS, type LocalStamp } from "./types.js";
import type { LoudnessMeasurement } from "./loudness.js";

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];

export function setupLocalTracks(saved: SavedTrackLibrary) {
  let measurementTimer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send("local-tracks:changed");
    if (measurementTimer) clearTimeout(measurementTimer);
    measurementTimer = setTimeout(() => {
      measurementTimer = undefined;
      void library.measureLoudness().catch(() => undefined);
    }, 100);
  };
  const library = new LocalTrackLibrary(
    path.join(app.getPath("userData"), "local-tracks"),
    changed,
  );
  void library.measureLoudness().catch(() => undefined);
  handleLocalTrackScheme(library, saved);

  ipcMain.handle(
    "local-tracks:loudness",
    (
      _event,
      id: unknown,
      audioFile: unknown,
      contentHash: unknown,
      measurement: LoudnessMeasurement,
    ) => {
      if (
        typeof id !== "string" ||
        typeof audioFile !== "string" ||
        (contentHash !== undefined && typeof contentHash !== "string")
      )
        return false;
      return library.storeLoudness(id, audioFile, contentHash, measurement);
    },
  );

  ipcMain.handle("local-tracks:list", () => library.list());

  ipcMain.handle("local-tracks:import", (_event, paths: unknown) =>
    library.importFiles(stringList(paths), { upgrade: true }),
  );

  ipcMain.handle("local-tracks:pick", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Audio", extensions: [...LOCAL_AUDIO_EXTENSIONS] }],
    };
    const picked = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return library.importFiles(picked.filePaths, { upgrade: true });
  });

  ipcMain.handle("local-tracks:pick-folder", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      properties: ["openDirectory"],
    };
    const picked = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return library.importFiles(picked.filePaths, { upgrade: true });
  });

  ipcMain.handle("local-tracks:tidy-plan", () => library.tidyPlan());

  ipcMain.handle("local-tracks:tidy-apply", (_event, ids: unknown) =>
    library.tidyApply(stringList(ids)),
  );

  ipcMain.handle("local-tracks:stamp", (_event, stamps: unknown) =>
    library.stamp(
      (Array.isArray(stamps) ? stamps : []).filter(
        (item): item is LocalStamp =>
          typeof item?.id === "string" &&
          /^[a-f0-9]{20}$/.test(item.id) &&
          typeof item.matchKey === "string" &&
          item.matchKey.length > 0 &&
          item.matchKey.length < 500,
      ),
    ),
  );

  ipcMain.handle("local-tracks:remove", (_event, ids: unknown) =>
    library.remove(stringList(ids)),
  );
  ipcMain.handle("local-tracks:probe", async (_event, id: unknown) => {
    const found =
      typeof id === "string" ? await library.locate("audio", id) : null;
    return found ? probeLocalAudio(found.path).catch(() => null) : null;
  });

  ipcMain.handle("local-tracks:remove-all", () => library.removeAll());

  ipcMain.handle("local-tracks:usage", () => library.usage());

  return library;
}
