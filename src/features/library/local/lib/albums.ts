import { foldText } from "../../../../../electron/local-tracks/matchKey";
import { artistsNest } from "../../../../../electron/local-tracks/pairing";
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

// the name most tracks are credited to, so "X & guest" still shows as X
function albumArtist(records: LocalTrackRecord[]): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    const name = primaryArtist(record.artist);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

// shortcut: one album title is one album unless the lead artists differ
// ("RPT MCK & tlinh" still nests in "RPT MCK"); a various-artists album splits
// per artist, upgrade when records carry an album-artist tag
export function groupLocalAlbums(records: LocalTrackRecord[]): LocalAlbum[] {
  const byTitle = new Map<string, LocalTrackRecord[][]>();
  for (const record of records) {
    const album = record.album?.trim();
    if (!album) continue;
    const key = foldText(album);
    const clusters = byTitle.get(key) ?? [];
    const home = clusters.find((cluster) =>
      cluster.some((member) => artistsNest(member.artist, record.artist)),
    );
    if (home) home.push(record);
    else clusters.push([record]);
    byTitle.set(key, clusters);
  }
  return [...byTitle.entries()]
    .flatMap(([title, clusters]) =>
      clusters.map((group, i) => {
        const sorted = [...group].sort(order);
        const tracks = sorted.map(localRecordToTrack);
        return {
          key: `${title}\u0000${i}`,
          title: sorted[0].album!.trim(),
          artist: albumArtist(sorted),
          coverUrl: tracks.find((track) => track.coverUrl)?.coverUrl ?? "",
          tracks,
        };
      }),
    )
    .sort((a, b) => a.title.localeCompare(b.title));
}
