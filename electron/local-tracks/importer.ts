import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { alacFormat, convertAlacToWav } from "./alac.js";
import { convertDsfToWav } from "./dsf.js";
import type { PreparedLocalFile } from "./workerTask.js";
import {
  audioExtension,
  readLocalTrackTags,
  type LocalTrackTags,
} from "./metadata.js";
import {
  LOCAL_AUDIO_EXTENSIONS,
  type LocalTrackQuality,
  type LocalTrackRecord,
} from "./types.js";

const SUPPORTED = new Set<string>(LOCAL_AUDIO_EXTENSIONS);

export async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha1");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex").slice(0, 20);
}

// A dropped or picked folder becomes its audio files, album order by name.
// Symlinked entries are skipped so a link cannot pull in files from elsewhere.
export async function expandAudioPaths(paths: string[]): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && SUPPORTED.has(audioExtension(full)))
        found.push(full);
    }
  };
  for (const source of paths) {
    const stat = await fsp.lstat(source).catch(() => null);
    if (stat?.isDirectory()) await walk(source).catch(() => undefined);
    else found.push(source);
  }
  return found;
}

// A file that passed the checks and is hashed, but is not copied yet, so the
// library can decide first whether it is new, a better copy, or not wanted.
export interface IncomingFile {
  real: string;
  source: string;
  extension: string;
  id: string;
  size: number;
  tags: LocalTrackTags;
  quality: LocalTrackQuality;
  alac: boolean;
}

export async function inspectLocalFile(
  source: string,
  known: Set<string>,
): Promise<IncomingFile | null> {
  const real = await fsp.realpath(source);
  const extension = audioExtension(real);
  if (!SUPPORTED.has(extension) || audioExtension(source) !== extension)
    throw new Error("unsupported");
  const stat = await fsp.stat(real);
  if (!stat.isFile()) throw new Error("not a file");
  const id = await hashFile(real);
  if (known.has(id)) return null;
  const tags = await readLocalTrackTags(real);
  // a .dsf is played as the 24-bit PCM it is decoded to (rate / 32)
  const quality: LocalTrackQuality =
    extension === "dsf"
      ? {
          lossless: true,
          bitDepth: 24,
          ...(tags.quality.sampleRate
            ? { sampleRate: tags.quality.sampleRate / 32 }
            : {}),
        }
      : tags.quality;
  // Chromium cannot play Apple Lossless, so it is decoded on import too
  const alac =
    extension === "m4a" && tags.codec?.toLowerCase() === "alac"
      ? await alacFormat(real)
      : null;
  return {
    real,
    source,
    extension,
    id,
    size: stat.size,
    tags,
    quality: alac ? { lossless: true, ...alac } : quality,
    alac: Boolean(alac),
  };
}

export async function commitLocalFile(
  file: IncomingFile,
  root: string,
  prepared?: PreparedLocalFile,
): Promise<LocalTrackRecord> {
  if (prepared) {
    if (!prepared.record)
      throw new Error(prepared.error ?? "File preparation failed");
    for (const folder of ["audio", "covers"] as const) {
      const name =
        folder === "audio"
          ? prepared.record.audioFile
          : prepared.record.coverFile;
      if (name)
        await fsp.rename(
          path.join(prepared.root, folder, name),
          path.join(root, folder, name),
        );
    }
    return { ...prepared.record, addedAt: Date.now() };
  }
  const { id, tags, extension } = file;
  const decodes = extension === "dsf" || file.alac;
  const audioFile = `${id}.${decodes ? "wav" : extension}`;
  const audioPath = path.join(root, "audio", audioFile);
  const converted =
    extension === "dsf"
      ? await convertDsfToWav(file.real, audioPath)
      : file.alac
        ? await convertAlacToWav(file.real, audioPath)
        : null;
  if (!converted) await fsp.copyFile(file.real, audioPath);
  const coverFile = tags.cover ? `${id}.${tags.cover.extension}` : undefined;
  if (tags.cover && coverFile) {
    await fsp.writeFile(path.join(root, "covers", coverFile), tags.cover.data);
  }
  return {
    id,
    contentHash: id,
    title: tags.title,
    artist: tags.artist,
    ...(tags.album ? { album: tags.album } : {}),
    ...(tags.trackNo ? { trackNo: tags.trackNo } : {}),
    ...(tags.discNo ? { discNo: tags.discNo } : {}),
    durationMs:
      tags.durationMs ||
      (converted
        ? Math.round((converted.frames / converted.sampleRate) * 1000)
        : 0),
    fileName: path.basename(file.source),
    audioFile,
    mimeType: converted ? "audio/wav" : tags.mimeType,
    ...(coverFile ? { coverFile } : {}),
    byteSize: converted ? (await fsp.stat(audioPath)).size : file.size,
    addedAt: Date.now(),
    ...(converted
      ? {
          ...file.quality,
          sampleRate: converted.sampleRate,
          bitDepth: converted.bitDepth,
        }
      : file.quality),
  };
}

export async function importLocalFile(
  source: string,
  root: string,
  known: Set<string>,
): Promise<LocalTrackRecord | null> {
  const file = await inspectLocalFile(source, known);
  return file ? commitLocalFile(file, root) : null;
}

// The existing record keeps its id (playlists, mixes, the queue and the lyrics
// cache all point at it) and takes the new audio. The old file and the
// duplicate cover are the caller's to remove once the index is saved.
export async function upgradedRecord(
  file: IncomingFile,
  root: string,
  existing: LocalTrackRecord,
  prepared?: PreparedLocalFile,
): Promise<{ record: LocalTrackRecord; stale: string[] }> {
  const fresh = await commitLocalFile(file, root, prepared);
  const stale = [path.join(root, "audio", existing.audioFile)];
  if (existing.coverFile && fresh.coverFile)
    stale.push(path.join(root, "covers", fresh.coverFile));
  const record: LocalTrackRecord = {
    ...existing,
    loudnessLufs: undefined,
    peakDb: undefined,
    audioFile: fresh.audioFile,
    mimeType: fresh.mimeType,
    byteSize: fresh.byteSize,
    durationMs: fresh.durationMs || existing.durationMs,
    fileName: fresh.fileName,
    contentHash: fresh.contentHash,
    lossless: fresh.lossless,
    bitDepth: fresh.bitDepth,
    sampleRate: fresh.sampleRate,
    bitrate: fresh.bitrate,
    coverFile: existing.coverFile ?? fresh.coverFile,
    album: existing.album ?? fresh.album,
    trackNo: existing.trackNo ?? fresh.trackNo,
    discNo: existing.discNo ?? fresh.discNo,
    // now a file of the owner's own, not a download
    source: undefined,
    hiRes: undefined,
  };
  return { record, stale };
}
