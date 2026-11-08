import type { Track } from "@/shared/types";
import { primaryArtist } from "../../../../electron/lossless/query";

// What the listener keeps or skips, learned on this device only. Each play adds
// to a few "arms" (the artist, the step from the previous artist, the time of
// day, the length). Ranking draws a random plausible keep-rate for every arm
// (Thompson sampling), so liked artists come first yet unknown ones still get
// a turn. Metadata only: no ids, urls or audio are stored.

export interface TastePlay {
  at: number;
  artist: string;
  prev: string;
  durationMs: number;
  kept: boolean;
}

/** plays that count as kept: listened this long, or past half of the song */
export const KEPT_AFTER_MS = 30_000;
const HALF_LIFE_MS = 60 * 24 * 3600 * 1000;
// a Beta(2,2) start so one play does not swing a whole arm
const PRIOR = 2;

export function artistKey(track: Pick<Track, "artists">): string {
  return (
    primaryArtist(track.artists).toLowerCase() || track.artists.toLowerCase()
  );
}

function period(at: number): string {
  const hour = new Date(at).getHours();
  return hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "day" : "eve";
}

export function armsOf(
  artist: string,
  prev: string,
  durationMs: number,
  at: number,
): string[] {
  return [
    `artist:${artist}`,
    `time:${period(at)}|${artist}`,
    prev ? `step:${prev}|${artist}` : "",
    prev === artist ? "flow:same" : "flow:new",
    `length:${Math.min(5, Math.floor(durationMs / 90_000))}`,
  ].filter(Boolean);
}

type Counts = Map<string, [hits: number, misses: number]>;

export function countArms(plays: TastePlay[], now: number): Counts {
  const counts: Counts = new Map();
  for (const play of plays) {
    const weight = Math.pow(0.5, Math.max(0, now - play.at) / HALF_LIFE_MS);
    for (const arm of armsOf(
      play.artist,
      play.prev,
      play.durationMs,
      play.at,
    )) {
      const entry = counts.get(arm) ?? [0, 0];
      entry[play.kept ? 0 : 1] += weight;
      counts.set(arm, entry);
    }
  }
  return counts;
}

function normal(random: () => number): number {
  return (
    Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())
  );
}

// Marsaglia-Tsang; shape is always >= 2 here because of PRIOR
function gamma(shape: number, random: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(random);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    if (Math.log(1 - random()) < 0.5 * x * x + d - d * v + d * Math.log(v))
      return d * v;
  }
}

export function sampleBeta(
  hits: number,
  misses: number,
  random: () => number,
): number {
  const a = gamma(hits + PRIOR, random);
  return a / (a + gamma(misses + PRIOR, random));
}

/** [candidates] best first, judged against what the listener kept before */
export function rankByTaste<T extends Track>(
  candidates: T[],
  previous: Track | null,
  plays: TastePlay[],
  now = Date.now(),
  random: () => number = Math.random,
): T[] {
  if (plays.length === 0) return candidates;
  const counts = countArms(plays, now);
  const prev = previous ? artistKey(previous) : "";
  const scored = candidates.map((track) => {
    const arms = armsOf(artistKey(track), prev, track.durationMs, now);
    let sum = 0;
    for (const arm of arms) {
      const [hits, misses] = counts.get(arm) ?? [0, 0];
      sum += sampleBeta(hits, misses, random);
    }
    return { track, score: sum / arms.length };
  });
  return scored.sort((a, b) => b.score - a.score).map((s) => s.track);
}
