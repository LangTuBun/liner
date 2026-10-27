import {
  cleanSoulseekQuery,
  queryKey,
} from "../../../../../electron/lossless/query";
import type { LocalTrackRecord } from "@/shared/media/local";

// same key the lossless downloader stamps on a record, so a catalog song and
// the file saved for it meet at one value
export function trackMatchKey(
  title: string | undefined,
  artist: string | undefined,
): string | null {
  const query = cleanSoulseekQuery({
    title: title ?? "",
    artist: artist ?? "",
  });
  return query.title ? queryKey(query) : null;
}

export function recordMatchKey(record: LocalTrackRecord): string | null {
  return record.matchKey ?? trackMatchKey(record.title, record.artist);
}
