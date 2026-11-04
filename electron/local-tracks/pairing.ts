import { recordMatchKey } from "./matchKey.js";
import { foldText } from "./matchKey.js";
import type { LocalTrackRecord } from "./types.js";

const SEPARATOR = "\u0000";
const SAME_LENGTH_MS = 2000;

// why a copy counts as the same recording as the one that stays
//  same          identical song key and length: safe to remove on import
//  artist-name   same title and length, artist spelled differently ("MCK" vs
//                "RPT MCK"): the owner confirms
//  longer-video  a YouTube copy that is longer, like a music video: the owner
//                confirms
export type PairKind = "same" | "artist-name" | "longer-video";

const CREDIT_SPLIT =
  /\s*(?:,|;|&|\bfeat\.?\s|\bft\.?\s|\bfeaturing\b|\bwith\b|\bx\b)\s*/i;

function leadTokens(artist: string): Set<string> {
  const lead = artist.split(CREDIT_SPLIT)[0] ?? "";
  return new Set(foldText(lead).split(" ").filter(Boolean));
}

// one lead artist's words sit inside the other's: "mck" inside "rpt mck"
export function artistsNest(a: string, b: string): boolean {
  const x = leadTokens(a);
  const y = leadTokens(b);
  if (x.size === 0 || y.size === 0) return false;
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return [...small].every((token) => big.has(token));
}

type Copy = Pick<
  LocalTrackRecord,
  "title" | "artist" | "matchKey" | "durationMs" | "source"
>;

export function pairKind(winner: Copy, other: Copy): PairKind | null {
  const keyWinner = recordMatchKey(winner);
  const keyOther = recordMatchKey(other);
  if (!keyWinner || !keyOther) return null;
  const [artistWinner, titleWinner] = keyWinner.split(SEPARATOR);
  const [artistOther, titleOther] = keyOther.split(SEPARATOR);
  if (!titleWinner || titleWinner !== titleOther) return null;

  const sameArtist = artistWinner === artistOther;
  if (
    !sameArtist &&
    !artistsNest(winner.artist, other.artist) &&
    !artistsNest(artistWinner, artistOther)
  )
    return null;

  const known = winner.durationMs > 0 && other.durationMs > 0;
  if (
    !known ||
    Math.abs(winner.durationMs - other.durationMs) <= SAME_LENGTH_MS
  )
    return sameArtist ? "same" : known ? "artist-name" : null;
  return other.source === "youtube" && other.durationMs > winner.durationMs
    ? "longer-video"
    : null;
}

const SOURCE_RANK = { soulseek: 1, youtube: 0 } as const;

// Higher is better. Lossless first, then the size of the audio, then who
// carries the album details and where it came from, then the newest.
function rank(record: LocalTrackRecord): number[] {
  const lossless = record.lossless ? 1 : 0;
  return [
    lossless,
    lossless && record.hiRes === "upsampled" ? 0 : 1,
    record.bitDepth ?? 0,
    record.sampleRate ?? 0,
    lossless ? 0 : (record.bitrate ?? 0),
    (record.album ? 1 : 0) + (record.trackNo ? 1 : 0),
    record.source ? SOURCE_RANK[record.source] : 2,
    record.addedAt,
  ];
}

// negative when `a` is the better copy, so a sort puts the best first
export function compareCopies(
  a: LocalTrackRecord,
  b: LocalTrackRecord,
): number {
  const x = rank(a);
  const y = rank(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
}
