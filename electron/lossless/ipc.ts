import fsp from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, app, ipcMain } from "electron";
import type { LocalTrackLibrary } from "../local-tracks/library.js";
import { probeLocalAudio } from "../local-tracks/metadata.js";
import { findBestCover } from "./covers.js";
import {
  LosslessDaemon,
  type InternalJob,
  type TrackRequest,
} from "./daemon.js";
import { readAnalysisSlice } from "./analysisSlice.js";
import { embedFlacCover } from "./flacPicture.js";
import { SOCKSEEK_VERSION, SockseekInstaller } from "./install.js";
import {
  cleanSoulseekQuery,
  cleanTitle,
  primaryArtist,
  queryKey,
  type HiResVerdict,
} from "./query.js";
import { tidyTitle } from "../local-tracks/riffMigration.js";
import { MAX_STREAM_BYTES, extensionForMime } from "./streamImport.js";
import type {
  LosslessDownloadRequest,
  LosslessJob,
  LosslessSnapshot,
} from "./types.js";

const PUSH_THROTTLE_MS = 250;
const MAX_BATCH = 500;
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function toTrackRequest(raw: unknown): TrackRequest | null {
  const r = (raw ?? {}) as Partial<LosslessDownloadRequest>;
  const title = text(r.title);
  if (!title) return null;
  const fromYoutube = r.fromYoutube === true;
  return {
    title,
    artist: text(r.artist),
    album: text(r.album) || undefined,
    durationSec: Number(r.durationMs) > 0 ? Number(r.durationMs) / 1000 : 0,
    thumbnail: text(r.thumbnail, 2000),
    artistMaybeWrong: fromYoutube,
    lengthUnreliable: fromYoutube,
  };
}

export function setupLossless(library: LocalTrackLibrary) {
  const workDir = path.join(app.getPath("userData"), "lossless");
  let pushTimer: ReturnType<typeof setTimeout> | null = null;

  const snapshot = (): LosslessSnapshot => ({
    status: {
      install: {
        installed: installer.installed(),
        supported: installer.supported(),
        version: SOCKSEEK_VERSION,
        ...installer.state,
      },
      ...daemon.status(),
    },
    jobs: daemon.list(),
  });

  const push = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const data = snapshot();
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("lossless:changed", data);
      }
    }, PUSH_THROTTLE_MS);
  };

  const installer = new SockseekInstaller(path.join(workDir, "bin"), push);

  const importDownload = async (
    job: InternalJob,
    filePath: string,
  ): Promise<Partial<LosslessJob>> => {
    const format = await probeLocalAudio(filePath).catch(() => null);
    if (!format?.lossless)
      throw new Error(
        format
          ? `Downloaded file is ${format.codec || "not lossless"}`
          : "Downloaded file could not be read",
      );
    const cover = await findBestCover(filePath, {
      artist: job.cleanArtist || job.artist,
      title: job.cleanTitle || job.title,
      thumbnail: job.thumbnail,
    }).catch(() => null);
    const extension = path.extname(filePath).slice(1).toLowerCase();
    let embedded = cover?.source === "embedded" && !cover.shrunk;
    if (cover && !embedded && extension === "flac") {
      embedded = await embedFlacCover(filePath, cover).then(
        () => true,
        () => false,
      );
    }
    try {
      const result = await library.importFiles([filePath]);
      const record = result.added[0];
      if (!record) {
        if (result.duplicates > 0)
          return { state: "skipped", error: "Already on this device" };
        throw new Error("Could not add the file to this device");
      }
      const extra =
        cover && !record.coverFile
          ? {
              data: cover.data,
              extension: EXTENSION_BY_MIME[cover.mimeType] ?? "jpg",
            }
          : undefined;
      await library.update(
        record.id,
        { source: "soulseek", matchKey: job.key, hiRes: null },
        extra,
      );
      return {
        localId: record.id,
        codec: format.codec,
        sampleRate: format.sampleRate ?? undefined,
        bitDepth: format.bitDepth ?? undefined,
        coverSize: cover ? `${cover.width}×${cover.height}` : "",
        hiRes: null,
      };
    } finally {
      await fsp.rm(filePath, { force: true });
    }
  };

  const daemon = new LosslessDaemon({
    workDir,
    binaryPath: () => (installer.installed() ? installer.binaryPath : null),
    mockFilesDir: process.env.LINER_SOCKSEEK_MOCK_DIR || undefined,
    onDownloaded: importDownload,
    hasLibraryTrack: async (key) =>
      (await library.list()).some((record) => record.matchKey === key),
    onChange: push,
  });

  ipcMain.handle("lossless:snapshot", () => snapshot());
  ipcMain.handle("lossless:install", () => {
    void installer.install();
    return snapshot();
  });
  ipcMain.handle(
    "lossless:account",
    (_event, username: unknown, password: unknown) => {
      const user = text(username, 200).trim();
      const pass = text(password, 200);
      if (!user || !pass) throw new Error("Username and password are required");
      daemon.saveAuth(user, pass);
      return snapshot();
    },
  );
  ipcMain.handle("lossless:account-clear", () => {
    daemon.clearAuth();
    return snapshot();
  });
  ipcMain.handle(
    "lossless:download",
    (_event, raw: unknown, preferHiRes: unknown) => {
      const track = toTrackRequest(raw);
      if (!track) throw new Error("Track title is missing");
      return daemon.submit({ ...track, preferHiRes: preferHiRes === true });
    },
  );
  ipcMain.handle(
    "lossless:download-batch",
    (_event, raw: unknown, name: unknown, preferHiRes: unknown) => {
      const tracks = (Array.isArray(raw) ? raw : [])
        .slice(0, MAX_BATCH)
        .map(toTrackRequest)
        .filter((t): t is TrackRequest => t !== null);
      if (!tracks.length) throw new Error("No tracks to download");
      return daemon.submitBatch(tracks, {
        name: text(name, 200),
        preferHiRes: preferHiRes === true,
      });
    },
  );
  ipcMain.handle("lossless:cancel", (_event, id: unknown) =>
    daemon.cancel(text(id, 64)),
  );
  ipcMain.handle("lossless:clear-finished", () => daemon.clearFinished());
  // a song the app saved from the stream it would have played, for when
  // soulseek has no copy
  ipcMain.handle("lossless:import-stream", async (_event, raw: unknown) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const title = text(r.title);
    if (!title) throw new Error("Track title is missing");
    const bytes = r.bytes instanceof Uint8Array ? r.bytes : null;
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_STREAM_BYTES)
      throw new Error("Audio data is missing or too large");
    const extension = extensionForMime(text(r.mimeType, 100));
    if (!extension) throw new Error("Unsupported audio format");
    const artist = text(r.artist);
    const streamsDir = path.join(workDir, "streams");
    await fsp.mkdir(streamsDir, { recursive: true });
    const file = path.join(
      streamsDir,
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${extension}`,
    );
    try {
      await fsp.writeFile(file, bytes);
      const cover = await findBestCover(file, {
        artist: primaryArtist(artist),
        title: cleanTitle(title),
        thumbnail: text(r.thumbnail, 2000),
      }).catch(() => null);
      const key = queryKey(
        cleanSoulseekQuery({ title, artist, artistMaybeWrong: true }),
      );
      const result = await library.importWithMetadata([
        {
          source: file,
          patch: {
            source: "youtube",
            matchKey: key,
            title: tidyTitle(title, artist),
            ...(artist ? { artist: primaryArtist(artist) || artist } : {}),
          },
        },
      ]);
      const localId = result.ids[0];
      if (!localId) throw new Error("Could not add the song to this device");
      if (cover)
        await library.update(
          localId,
          {},
          {
            data: cover.data,
            extension: EXTENSION_BY_MIME[cover.mimeType] ?? "jpg",
          },
        );
      return { localId };
    } finally {
      await fsp.rm(file, { force: true });
    }
  });
  ipcMain.handle(
    "lossless:analysis-slice",
    async (_event, localId: unknown) => {
      const found = await library.locate("audio", text(localId, 64));
      if (!found) throw new Error("Track is not on this device");
      return readAnalysisSlice(found.path, found.record.durationMs / 1000);
    },
  );
  ipcMain.handle(
    "lossless:set-hires",
    async (_event, localId: unknown, verdict: unknown) => {
      const id = text(localId, 64);
      const value: HiResVerdict =
        verdict === "hires" || verdict === "upsampled" ? verdict : "unknown";
      await library.update(id, { hiRes: value });
      daemon.updateJob(id, { hiRes: value });
    },
  );

  return { stop: () => daemon.stop() };
}
