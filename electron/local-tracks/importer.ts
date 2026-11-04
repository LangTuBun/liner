import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { convertDsfToWav } from "./dsf.js";
import { audioExtension, readLocalTrackTags } from "./metadata.js";
import { LOCAL_AUDIO_EXTENSIONS, type LocalTrackRecord } from "./types.js";

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

export async function importLocalFile(
  source: string,
  root: string,
  known: Set<string>,
): Promise<LocalTrackRecord | null> {
  const real = await fsp.realpath(source);
  const extension = audioExtension(real);
  if (!SUPPORTED.has(extension) || audioExtension(source) !== extension)
    throw new Error("unsupported");
  const stat = await fsp.stat(real);
  if (!stat.isFile()) throw new Error("not a file");
  const id = await hashFile(real);
  if (known.has(id)) return null;
  const isDsd = extension === "dsf";
  const audioFile = `${id}.${isDsd ? "wav" : extension}`;
  const audioPath = path.join(root, "audio", audioFile);
  const converted = isDsd ? await convertDsfToWav(real, audioPath) : null;
  if (!converted) await fsp.copyFile(real, audioPath);
  const tags = await readLocalTrackTags(real);
  const coverFile = tags.cover ? `${id}.${tags.cover.extension}` : undefined;
  if (tags.cover && coverFile) {
    await fsp.writeFile(path.join(root, "covers", coverFile), tags.cover.data);
  }
  return {
    id,
    title: tags.title,
    artist: tags.artist,
    ...(tags.album ? { album: tags.album } : {}),
    durationMs:
      tags.durationMs ||
      (converted
        ? Math.round((converted.frames / converted.sampleRate) * 1000)
        : 0),
    fileName: path.basename(source),
    audioFile,
    mimeType: converted ? "audio/wav" : tags.mimeType,
    ...(coverFile ? { coverFile } : {}),
    byteSize: converted ? (await fsp.stat(audioPath)).size : stat.size,
    addedAt: Date.now(),
  };
}
