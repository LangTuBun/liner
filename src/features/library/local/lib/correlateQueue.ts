import type { Track } from "@/shared/types";
import type { MixSource } from "@/features/mix/lib/smartMix";
import type { Vibe } from "@/features/mix/lib/vibe";
import {
  armsOf,
  artistKey,
  countArms,
  type TastePlay,
} from "@/features/taste/lib/tasteModel";
import { primaryArtist } from "../../../../../electron/lossless/query";
import { trackMatchKey } from "./downloadMatch";

export interface CorrelateQueueOptions {
  vibes?: Map<string, Vibe>;
  plays?: TastePlay[];
  related?: Track[];
  sources?: MixSource[];
  now?: number;
}

interface CandidateItem {
  index: number;
  track: Track;
  artist: string;
  allArtists: string[];
  matchKey: string | null;
  tokens: Map<string, number>;
  vec?: number[];
  relatedTrackScore: number;
  relatedArtistScore: number;
  learnedNeighborScore: number;
}

const VIBE_WEIGHT = 1.6;
const TEMPO_SCALE = 0.6;
const BACK_TO_BACK_ARTIST_PENALTY = 0.55;
const TWO_STEP_ARTIST_PENALTY = 0.22;

function scriptOf(text: string): string {
  if (/[가-힯]/.test(text)) return "hangul";
  if (/[぀-ヿ]/.test(text)) return "kana";
  if (/[一-鿿]/.test(text)) return "han";
  if (/[ạảãăằắẳẵặâầấẩẫậđẹẻẽêềếểễệịỉĩọỏõôồốổỗộơờớởỡợụủũưừứửữựỳỵỷỹ]/i.test(text))
    return "viet";
  return "latin";
}

function lengthBucket(durationMs: number): string {
  const seconds = durationMs / 1000;
  if (seconds < 150) return "short";
  if (seconds > 270) return "long";
  return "mid";
}

export function extractArtists(artistsText: string): string[] {
  const primary = primaryArtist(artistsText).toLowerCase().trim();
  const parts = artistsText
    .split(/,|&|\b(?:feat\.?|ft\.?|with|x)\b/i)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([primary, ...parts].filter(Boolean))];
}

function attachVibeVectors(
  items: CandidateItem[],
  vibes?: Map<string, Vibe>,
): void {
  if (!vibes || vibes.size === 0) return;
  const measured = items.filter((item) => vibes.has(item.track.id));
  if (measured.length < 2) return;
  const raw = (vibe: Vibe) => [
    vibe.energy,
    Math.log(Math.max(vibe.brightness, 1)),
    Math.log2(Math.max(vibe.tempo, 1)) * (0.4 + 0.6 * vibe.pulse),
  ];
  const rows = measured.map((item) => raw(vibes.get(item.track.id)!));
  const dims = rows[0].length;
  const mean = Array.from(
    { length: dims },
    (_, d) => rows.reduce((sum, row) => sum + row[d], 0) / rows.length,
  );
  const spread = mean.map(
    (m, d) =>
      Math.sqrt(
        rows.reduce((sum, row) => sum + (row[d] - m) ** 2, 0) / rows.length,
      ) || 1,
  );
  measured.forEach((item, index) => {
    item.vec = rows[index].map(
      (value, d) =>
        ((value - mean[d]) / spread[d]) * (d === 2 ? TEMPO_SCALE : 1),
    );
  });
}

function vibeSimilarity(a: number[], b: number[]): number {
  let squared = 0;
  for (let d = 0; d < a.length; d++) squared += (a[d] - b[d]) ** 2;
  return Math.exp(-squared / 2);
}

function tokenJaccard(a: CandidateItem, b: CandidateItem): number {
  let min = 0;
  let max = 0;
  for (const [token, weight] of a.tokens) {
    const other = b.tokens.get(token) ?? 0;
    min += Math.min(weight, other);
    max += Math.max(weight, other);
  }
  for (const [token, weight] of b.tokens) {
    if (!a.tokens.has(token)) max += weight;
  }
  return max === 0 ? 0 : min / max;
}

function pairSimilarity(a: CandidateItem, b: CandidateItem): number {
  const meta = tokenJaccard(a, b);
  if (a.vec && b.vec) {
    return (
      (meta + VIBE_WEIGHT * vibeSimilarity(a.vec, b.vec)) / (1 + VIBE_WEIGHT)
    );
  }
  return meta;
}

/**
 * Orders `tracks` starting with `seed` so that subsequent tracks correlate with
 * the seed and flow smoothly from one song to the next, combining:
 * 1. Online co-listening neighborhood (`related` from RDAMVM radio when available)
 * 2. On-device 4D acoustic vibe vectors (`vibes`: loudness, brightness, tempo, pulse)
 * 3. Saved mix/playlist co-occurrence & track metadata (script, era, duration)
 * 4. On-device listening history (`plays`: artist keep-rate & transition steps)
 * 5. Artist spacing cooldown so songs by the seed artist weave in naturally
 */
export function correlateQueue(
  seed: Track,
  tracks: Track[],
  options: CorrelateQueueOptions = {},
): Track[] {
  const now = options.now ?? Date.now();
  const seenIds = new Set<string>([seed.id]);
  const pool: Track[] = [seed];
  for (const track of tracks) {
    if (!seenIds.has(track.id)) {
      seenIds.add(track.id);
      pool.push(track);
    }
  }
  if (pool.length <= 2) return pool;

  // Map track -> mix/playlist source memberships
  const trackSources = new Map<string, Set<string>>();
  const artistSources = new Map<string, Set<string>>();
  const sourceSizes = new Map<string, number>();
  for (const source of options.sources ?? []) {
    sourceSizes.set(source.id, source.tracks.length);
    for (const t of source.tracks) {
      const key = trackMatchKey(t.title, t.artists) ?? t.id;
      const set = trackSources.get(key) ?? new Set<string>();
      set.add(source.id);
      trackSources.set(key, set);

      const art = artistKey(t);
      const artSet = artistSources.get(art) ?? new Set<string>();
      artSet.add(source.id);
      artistSources.set(art, artSet);
    }
  }

  // Online RDAMVM co-listening lookup tables
  const relatedTrackRank = new Map<string, number>();
  const relatedArtistRank = new Map<string, number>();
  const relatedList = options.related ?? [];
  const totalRelated = Math.max(relatedList.length, 1);
  relatedList.forEach((rel, index) => {
    const rankScore = 1 - 0.35 * (index / totalRelated);
    const key = trackMatchKey(rel.title, rel.artists);
    if (key && !relatedTrackRank.has(key)) {
      relatedTrackRank.set(key, rankScore);
    }
    for (const art of extractArtists(rel.artists)) {
      if (!relatedArtistRank.has(art)) {
        relatedArtistRank.set(art, 0.72 * rankScore);
      }
    }
  });

  // On-device play history & learned artist transition neighbors
  const plays = options.plays ?? [];
  const armCounts = plays.length > 0 ? countArms(plays, now) : null;
  const seedPrimaryArtist = artistKey(seed);
  const learnedNeighbors = new Map<string, number>();
  if (armCounts) {
    for (const [arm, [hits, misses]] of armCounts) {
      if (!arm.startsWith("step:")) continue;
      const [from, to] = arm.slice(5).split("|");
      if (from === seedPrimaryArtist && to && hits > misses) {
        const strength = (hits - misses) / (hits + misses + 2);
        learnedNeighbors.set(
          to,
          Math.max(learnedNeighbors.get(to) ?? 0, 0.45 * strength),
        );
      } else if (to === seedPrimaryArtist && from && hits > misses) {
        const strength = (hits - misses) / (hits + misses + 2);
        learnedNeighbors.set(
          from,
          Math.max(learnedNeighbors.get(from) ?? 0, 0.35 * strength),
        );
      }
    }
  }

  const totalPool = pool.length;
  const sourceWeight = (id: string) =>
    Math.log(1 + totalPool / Math.max(1, sourceSizes.get(id) ?? totalPool));

  const items: CandidateItem[] = pool.map((track, index) => {
    const artist = artistKey(track);
    const allArtists = extractArtists(track.artists);
    const matchKey = trackMatchKey(track.title, track.artists);
    const tokens = new Map<string, number>();
    const add = (token: string, weight: number) =>
      tokens.set(token, Math.max(tokens.get(token) ?? 0, weight));

    const lookupKey = matchKey ?? track.id;
    for (const srcId of trackSources.get(lookupKey) ?? []) {
      add(`s:${srcId}`, 2.0 * sourceWeight(srcId));
    }
    for (const srcId of artistSources.get(artist) ?? []) {
      add(`s:${srcId}`, 0.9 * sourceWeight(srcId));
    }
    if (track.album?.id || track.album?.title) {
      add(`al:${(track.album.id || track.album.title).toLowerCase()}`, 1.0);
    }
    const year = Number.parseInt(track.releaseDate ?? "", 10);
    if (year > 1900) add(`y:${Math.floor(year / 5)}`, 0.8);
    add(`l:${scriptOf(`${track.title} ${track.artists}`)}`, 1.5);
    add(`d:${lengthBucket(track.durationMs)}`, 0.6);

    const relatedTrackScore = matchKey
      ? (relatedTrackRank.get(matchKey) ?? 0)
      : 0;
    let relatedArtistScore = 0;
    for (const art of allArtists) {
      relatedArtistScore = Math.max(
        relatedArtistScore,
        relatedArtistRank.get(art) ?? 0,
      );
    }
    if (relatedArtistScore === 0 && allArtists.includes(seedPrimaryArtist)) {
      relatedArtistScore = 0.35;
    }

    let learnedNeighborScore = 0;
    for (const art of allArtists) {
      learnedNeighborScore = Math.max(
        learnedNeighborScore,
        learnedNeighbors.get(art) ?? 0,
      );
    }

    return {
      index,
      track,
      artist,
      allArtists,
      matchKey,
      tokens,
      relatedTrackScore,
      relatedArtistScore,
      learnedNeighborScore,
    };
  });

  attachVibeVectors(items, options.vibes);

  const tasteKeepProbability = (
    candidate: CandidateItem,
    prevArtist: string,
  ): number => {
    if (!armCounts) return 0.5;
    const arms = armsOf(
      candidate.artist,
      prevArtist,
      candidate.track.durationMs,
      now,
    );
    let sum = 0;
    for (const arm of arms) {
      const [hits, misses] = armCounts.get(arm) ?? [0, 0];
      sum += (hits + 2) / (hits + misses + 4);
    }
    return sum / arms.length;
  };

  const seedItem = items[0];
  const remaining = new Set<CandidateItem>(items.slice(1));
  const ordered: CandidateItem[] = [seedItem];

  while (remaining.size > 0) {
    const prev = ordered[ordered.length - 1];
    const prev2 = ordered.length >= 2 ? ordered[ordered.length - 2] : undefined;
    let best: CandidateItem | null = null;
    let bestScore = -Infinity;

    for (const candidate of remaining) {
      const stepSim = pairSimilarity(prev, candidate);
      const seedSim = pairSimilarity(seedItem, candidate);
      const coListeningBoost =
        candidate.relatedTrackScore > 0
          ? candidate.relatedTrackScore
          : Math.max(
              candidate.relatedArtistScore,
              candidate.learnedNeighborScore,
            );
      const tasteDelta = tasteKeepProbability(candidate, prev.artist) - 0.5;

      const sameAsPrev =
        candidate.artist === prev.artist ||
        candidate.allArtists.some((a) => prev.allArtists.includes(a));
      const sameAsPrev2 =
        prev2 !== undefined &&
        (candidate.artist === prev2.artist ||
          candidate.allArtists.some((a) => prev2.allArtists.includes(a)));

      const artistPenalty =
        (sameAsPrev ? BACK_TO_BACK_ARTIST_PENALTY : 0) +
        (sameAsPrev2 ? TWO_STEP_ARTIST_PENALTY : 0);

      const score =
        0.45 * stepSim +
        0.35 * seedSim +
        coListeningBoost +
        0.45 * tasteDelta -
        artistPenalty;

      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    ordered.push(best!);
    remaining.delete(best!);
  }

  return ordered.map((item) => item.track);
}
