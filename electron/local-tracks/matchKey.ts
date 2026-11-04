import { cleanSoulseekQuery } from "../lossless/query.js";
import type { LocalTrackRecord } from "./types.js";

const SEPARATOR = "\u0000";

// remaster and single labels name the same recording; live, remix and
// acoustic stay in the title because they are different recordings
const VERSION_SUFFIXES = [
  /\s*[-–([]\s*(?:\d{4}\s+)?remaster(?:ed)?(?:\s+(?:version|\d{4}))?\s*[)\]]?\s*$/i,
  /\s*-\s*single(?:\s+version)?\s*$/i,
];

function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function keyOf(artist: string, title: string): string | null {
  let bare = title;
  for (const suffix of VERSION_SUFFIXES) bare = bare.replace(suffix, "");
  const a = fold(artist);
  const t = fold(bare);
  return a && t ? `${a}${SEPARATOR}${t}` : null;
}

// same key the lossless downloader stamps on a record (after the same
// folding), so a catalog song and the file saved for it meet at one value
export function trackMatchKey(
  title: string | undefined,
  artist: string | undefined,
): string | null {
  const query = cleanSoulseekQuery({
    title: title ?? "",
    artist: artist ?? "",
  });
  return keyOf(query.artist ?? "", query.title ?? "");
}

export function recordMatchKey(
  record: Pick<LocalTrackRecord, "title" | "artist" | "matchKey">,
): string | null {
  const stamped = record.matchKey;
  if (stamped) {
    const at = stamped.indexOf(SEPARATOR);
    return at < 0
      ? stamped
      : (keyOf(stamped.slice(0, at), stamped.slice(at + 1)) ?? stamped);
  }
  return trackMatchKey(record.title, record.artist);
}
