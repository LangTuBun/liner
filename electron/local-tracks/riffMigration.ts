import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanSoulseekQuery, queryKey } from "../lossless/query.js";
import type { LocalTrackLibrary } from "./library.js";
import type { LocalTrackPatch, LocalTrackRecord } from "./types.js";

// riff, the app this one grew out of, kept lossless downloads as local_<hash>.flac
// and the real titles only in its library.json; this brings both over
interface RiffItem {
  file?: string;
  title?: string;
  artist?: string;
  addedAt?: number;
  matchKey?: string;
  hiRes?: { verdict?: string } | string | null;
}

const BATCH = 5;
const MARKER = "riff-migration.json";

function riffDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.RIFF_DATA_DIR) dirs.push(process.env.RIFF_DATA_DIR);
  if (process.platform === "win32")
    dirs.push(
      path.join(
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
        "Riff",
      ),
    );
  else if (process.platform === "darwin")
    dirs.push(
      path.join(os.homedir(), "Library", "Application Support", "Riff"),
    );
  else dirs.push(path.join(os.homedir(), ".cache", "devsize"));
  return dirs;
}

export function tidyTitle(title: string, artist: string): string {
  let out = title.trim();
  const prefix = `${artist} - `;
  if (artist && out.toLowerCase().startsWith(prefix.toLowerCase()))
    out = out.slice(prefix.length);
  out = out.replace(
    /\s*[([][^)\]]*\b(official|audio|video|lyrics?|visuali[sz]er|hd|hq|4k|mv)\b[^)\]]*[)\]]/gi,
    "",
  );
  return out.replace(/\s+/g, " ").trim() || title.trim();
}

function hiResOf(value: RiffItem["hiRes"]): LocalTrackRecord["hiRes"] {
  const verdict = typeof value === "string" ? value : value?.verdict;
  return verdict === "hires" || verdict === "upsampled" || verdict === "unknown"
    ? verdict
    : null;
}

export function toPatch(item: RiffItem): LocalTrackPatch {
  const artist = (item.artist ?? "").trim();
  const title = tidyTitle(item.title ?? "", artist);
  const matchKey =
    item.matchKey ||
    queryKey(cleanSoulseekQuery({ title: item.title ?? "", artist }));
  return {
    source: "soulseek",
    matchKey,
    hiRes: hiResOf(item.hiRes),
    ...(title ? { title } : {}),
    ...(artist ? { artist } : {}),
    ...(item.addedAt ? { addedAt: item.addedAt } : {}),
  };
}

// runs once; returns the number of tracks it brought in or fixed, or null when
// there is nothing to migrate
export async function migrateRiffLibrary(
  library: LocalTrackLibrary,
  root: string,
  onProgress: () => void,
): Promise<number | null> {
  const marker = path.join(root, MARKER);
  const migrated = await fsp.stat(marker).then(
    () => true,
    () => false,
  );
  if (migrated) return null;
  for (const dir of riffDirs()) {
    let index: Record<string, RiffItem>;
    try {
      index = JSON.parse(
        await fsp.readFile(path.join(dir, "library.json"), "utf8"),
      );
    } catch {
      continue;
    }
    const entries = Object.values(index)
      .filter((item) => item.file && item.title)
      .map((item) => ({
        source: path.join(dir, "library", item.file!),
        patch: toPatch(item),
      }));
    let done = 0;
    let failed = 0;
    for (let i = 0; i < entries.length; i += BATCH) {
      const tally = await library.importWithMetadata(
        entries.slice(i, i + BATCH),
      );
      done += tally.imported + tally.updated;
      failed += tally.failed;
      onProgress();
    }
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(
      marker,
      JSON.stringify({ from: dir, done, failed, at: Date.now() }),
    );
    return done;
  }
  return null;
}
