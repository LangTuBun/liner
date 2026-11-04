import { primaryArtist } from "../../../../../electron/lossless/query";
import {
  localRecordToTrack,
  type LocalTrackRecord,
} from "@/shared/media/local";
import type { Track } from "@/shared/types";

export interface LocalAlbum {
  key: string;
  title: string;
  artist: string;
  coverUrl: string;
  tracks: Track[];
}

// files named "07 - Song" carry their number even when the tag has none
const numberInName = (record: LocalTrackRecord) => {
  const match = /^\s*(\d{1,3})\b/.exec(record.fileName);
  return match ? Number(match[1]) : Infinity;
};

const order = (a: LocalTrackRecord, b: LocalTrackRecord) =>
  (a.discNo ?? 1) - (b.discNo ?? 1) ||
  (a.trackNo ?? numberInName(a)) - (b.trackNo ?? numberInName(b)) ||
  a.addedAt - b.addedAt;

// shortcut: grouped by album title and the first credited artist, so a
// various-artists album splits per artist; upgrade when albums get an id
export function groupLocalAlbums(records: LocalTrackRecord[]): LocalAlbum[] {
  const groups = new Map<string, LocalTrackRecord[]>();
  for (const record of records) {
    const album = record.album?.trim();
    if (!album) continue;
    const artist = primaryArtist(record.artist);
    const key = `${artist}\u0000${album}`.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const sorted = [...group].sort(order);
      const tracks = sorted.map(localRecordToTrack);
      return {
        key,
        title: sorted[0].album!.trim(),
        artist: primaryArtist(sorted[0].artist),
        coverUrl: tracks.find((track) => track.coverUrl)?.coverUrl ?? "",
        tracks,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}
