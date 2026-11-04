import { api } from "@/shared/api";
import { toClientTrack } from "@/shared/api/track";
import type { SearchAlbumItem } from "@/shared/contracts/catalog";
import { localFileId, type LocalStamp } from "@/shared/media/local";
import { foldText } from "../../../../../electron/local-tracks/matchKey";
import { artistsNest } from "../../../../../electron/local-tracks/pairing";
import { trackMatchKey } from "./downloadMatch";
import type { LocalAlbum } from "./albums";

const LENGTH_SLACK_MS = 3000;
const SHARE_PAIRED = 0.6;

export interface AlbumLink {
  albumId: string;
  title: string;
  coverUrl: string;
  // each local file told which catalog song it is, so the album's rows play it
  stamps: LocalStamp[];
}

// the cleaned title half of a song key, so "Baby (feat. X)" meets "Baby"
const titleOf = (title: string) =>
  trackMatchKey(title, "x")?.split("\u0000")[1] ?? "";

// Finds the catalog edition of a local album: same title, a lead artist that
// nests, about the same number of songs, and most songs paired by title and
// length. Returns null rather than guess an edition.
export async function findCatalogAlbum(
  album: LocalAlbum,
): Promise<AlbumLink | null> {
  const found = await api.search(`${album.artist} ${album.title}`, "album");
  const candidates = found.items
    .filter((item): item is SearchAlbumItem => item.type === "album")
    .slice(0, 5);
  for (const candidate of candidates) {
    if (foldText(candidate.title) !== foldText(album.title)) continue;
    if (!candidate.artists.some((a) => artistsNest(a.name, album.artist)))
      continue;
    const detail = await api.getAlbum(candidate.id);
    const rows = detail.tracks.map(toClientTrack);
    if (Math.abs(rows.length - album.tracks.length) > 2) continue;

    const used = new Set<number>();
    const stamps: LocalStamp[] = [];
    for (const local of album.tracks) {
      const title = titleOf(local.title);
      const at = rows.findIndex((row, i) => {
        if (used.has(i) || titleOf(row.title) !== title) return false;
        return (
          !local.durationMs ||
          !row.durationMs ||
          Math.abs(local.durationMs - row.durationMs) <= LENGTH_SLACK_MS
        );
      });
      const matchKey =
        at >= 0 ? trackMatchKey(rows[at].title, rows[at].artists) : null;
      if (at < 0 || !matchKey) continue;
      used.add(at);
      stamps.push({ id: localFileId(local.id), matchKey });
    }
    if (stamps.length < Math.ceil(album.tracks.length * SHARE_PAIRED)) continue;
    return {
      albumId: candidate.id,
      title: detail.title,
      coverUrl: rows.find((row) => row.coverUrl)?.coverUrl ?? "",
      stamps,
    };
  }
  return null;
}
