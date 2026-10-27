import type { Track } from "@/shared/types";
import { isLocalTrackId } from "@/shared/media/local";
import { trackMatchKey } from "@/features/library/local/lib/downloadMatch";
import { primaryArtist } from "../../../../electron/lossless/query";
import type { Vibe } from "./vibe";

// Smart mix: pulls songs out of any number of playlists and albums, sorts them
// into clusters of songs that belong together, and orders each cluster.
//
// Songs carry no audio features here, so closeness comes from how the listener
// already groups them: songs that sit in the same playlists (the playlists are
// the vibe sessions), the same album, the same artist, the language of the
// title, the length and the era. Similarity is a weighted Jaccard over those
// tokens. The number of clusters is the one that separates the songs best.

export interface MixSource {
  id: string;
  tracks: Track[];
}

export type MixMode = "flow" | "variety";

export interface MixCluster {
  id: number;
  label: string;
  tracks: Track[];
}

export interface MixResult {
  clusters: MixCluster[];
  // every cluster in play order: flow chains the clusters, variety interleaves them
  combined: Track[];
  duplicatesRemoved: number;
}

export interface MixOptions {
  mode: MixMode;
  clusterCount?: number;
  random?: () => number;
  // measured sound of songs, by track id; songs without one go by the rest
  vibes?: Map<string, Vibe>;
}

interface Item {
  index: number;
  track: Track;
  artist: string;
  tokens: Map<string, number>;
  // loudness, brightness and tempo as z-scores across the songs being mixed
  vec?: number[];
}

type Sim = (a: Item, b: Item) => number;

const MAX_TRACKS = 1500;
const MAX_CLUSTERS = 10;
const MIN_CLUSTER = 3;
const SAME_ARTIST_PENALTY = 0.35;
const POLISH_LIMIT = 400;
// how much the measured sound counts against playlists, album, artist and so on
const VIBE_WEIGHT = 1.5;
const TEMPO_SCALE = 0.6;

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

function artistOf(track: Track): string {
  return (
    primaryArtist(track.artists).toLowerCase() || track.artists.toLowerCase()
  );
}

// a downloaded copy plays offline, so it wins over the streamed one
function betterCopy(a: Track, b: Track): Track {
  return isLocalTrackId(b.id) && !isLocalTrackId(a.id) ? b : a;
}

function buildItems(
  sources: MixSource[],
  vibes?: Map<string, Vibe>,
): {
  items: Item[];
  duplicatesRemoved: number;
} {
  const byKey = new Map<string, { track: Track; sources: Set<string> }>();
  let duplicatesRemoved = 0;
  for (const source of sources) {
    for (const track of source.tracks) {
      const key = trackMatchKey(track.title, track.artists) ?? track.id;
      const seen = byKey.get(key);
      if (seen) {
        duplicatesRemoved += 1;
        seen.track = betterCopy(seen.track, track);
        seen.sources.add(source.id);
      } else byKey.set(key, { track, sources: new Set([source.id]) });
    }
  }
  const entries = [...byKey.values()].slice(0, MAX_TRACKS);
  const sourceSize = new Map<string, number>();
  const artistSources = new Map<string, Map<string, number>>();
  for (const { track, sources: ids } of entries) {
    const artist = artistOf(track);
    const shared = artistSources.get(artist) ?? new Map<string, number>();
    artistSources.set(artist, shared);
    for (const id of ids) {
      sourceSize.set(id, (sourceSize.get(id) ?? 0) + 1);
      shared.set(id, (shared.get(id) ?? 0) + 1);
    }
  }
  const total = entries.length;
  // a source that holds everything says nothing about a song
  const sourceWeight = (id: string) =>
    Math.log(1 + total / (sourceSize.get(id) ?? total));
  const items = entries.map(({ track, sources: ids }, index) => {
    const artist = artistOf(track);
    const tokens = new Map<string, number>();
    const add = (token: string, weight: number) =>
      tokens.set(token, Math.max(tokens.get(token) ?? 0, weight));
    for (const id of ids) add(`s:${id}`, 2 * sourceWeight(id));
    // the playlists an artist shows up in tie their other songs together
    for (const id of artistSources.get(artist)?.keys() ?? [])
      add(`s:${id}`, 0.8 * sourceWeight(id));
    add(`a:${artist}`, 1.2);
    if (track.album?.id) add(`al:${track.album.id}`, 1.5);
    const year = Number.parseInt(track.releaseDate ?? "", 10);
    if (year > 1900) add(`y:${Math.floor(year / 5)}`, 0.8);
    add(`l:${scriptOf(`${track.title} ${track.artists}`)}`, 1.5);
    add(`d:${lengthBucket(track.durationMs)}`, 0.5);
    return { index, track, artist, tokens };
  });
  attachVibes(items, vibes);
  return { items, duplicatesRemoved };
}

function attachVibes(items: Item[], vibes?: Map<string, Vibe>) {
  if (!vibes || vibes.size === 0) return;
  const measured = items.filter((item) => vibes.has(item.track.id));
  if (measured.length < 4) return;
  const raw = (vibe: Vibe) => [
    vibe.energy,
    Math.log(Math.max(vibe.brightness, 1)),
    // an unclear beat says little about speed, so it pulls less
    Math.log2(vibe.tempo) * (0.4 + 0.6 * vibe.pulse),
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

function weightedJaccard(a: Item, b: Item, skipArtist: boolean): number {
  let min = 0;
  let max = 0;
  for (const [token, weight] of a.tokens) {
    if (skipArtist && token.startsWith("a:")) continue;
    const other = b.tokens.get(token) ?? 0;
    min += Math.min(weight, other);
    max += Math.max(weight, other);
  }
  for (const [token, weight] of b.tokens) {
    if (skipArtist && token.startsWith("a:")) continue;
    if (!a.tokens.has(token)) max += weight;
  }
  return max === 0 ? 0 : min / max;
}

// every pair once, so choosing the cluster count can try many candidates cheaply
function similarityMatrix(items: Item[], skipArtist = false): Sim {
  const n = items.length;
  const table = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    table[i * n + i] = 1;
    for (let j = i + 1; j < n; j++) {
      let value = weightedJaccard(items[i], items[j], skipArtist);
      const a = items[i].vec;
      const b = items[j].vec;
      if (a && b)
        value =
          (value + VIBE_WEIGHT * vibeSimilarity(a, b)) / (1 + VIBE_WEIGHT);
      table[i * n + j] = value;
      table[j * n + i] = value;
    }
  }
  return (a, b) => table[a.index * n + b.index];
}

function mostCentral(group: Item[], sim: Sim): Item {
  let best = group[0];
  let bestTotal = -1;
  for (const candidate of group) {
    let total = 0;
    for (const other of group) total += sim(candidate, other);
    if (total > bestTotal) {
      bestTotal = total;
      best = candidate;
    }
  }
  return best;
}

// k-medoids with farthest-first seeding: deterministic for a given random()
function cluster(
  items: Item[],
  k: number,
  sim: Sim,
  random: () => number,
): Item[][] {
  if (k <= 1 || items.length <= k) return [items];
  const medoids: Item[] = [items[Math.floor(random() * items.length)]];
  while (medoids.length < k) {
    let far = items[0];
    let farScore = Infinity;
    for (const item of items) {
      const closest = Math.max(...medoids.map((m) => sim(item, m)));
      if (closest < farScore) {
        farScore = closest;
        far = item;
      }
    }
    medoids.push(far);
  }
  let groups: Item[][] = [];
  for (let round = 0; round < 8; round++) {
    groups = medoids.map(() => []);
    for (const item of items) {
      let best = 0;
      let bestScore = -1;
      medoids.forEach((medoid, index) => {
        const score = sim(item, medoid);
        if (score > bestScore) {
          bestScore = score;
          best = index;
        }
      });
      groups[best].push(item);
    }
    let moved = false;
    groups.forEach((group, index) => {
      if (group.length === 0) return;
      const center = mostCentral(group, sim);
      if (center !== medoids[index]) {
        medoids[index] = center;
        moved = true;
      }
    });
    if (!moved) break;
  }
  const kept = groups.filter((group) => group.length > 0);
  // a cluster of one or two songs is a stray, not a mix
  const mixes = kept.filter((group) => group.length >= MIN_CLUSTER);
  if (mixes.length === 0) return [items];
  for (const stray of kept
    .filter((group) => group.length < MIN_CLUSTER)
    .flat()) {
    let best = mixes[0];
    let bestScore = -1;
    for (const group of mixes) {
      const score = Math.max(...group.map((item) => sim(stray, item)));
      if (score > bestScore) {
        bestScore = score;
        best = group;
      }
    }
    best.push(stray);
  }
  return mixes;
}

// mean silhouette: how much closer a song is to its own cluster than to the
// nearest other one, from -1 (wrong cluster) to 1 (clearly its own)
function silhouette(groups: Item[][], sim: Sim): number {
  if (groups.length < 2) return -1;
  let total = 0;
  let count = 0;
  groups.forEach((group, gi) => {
    for (const item of group) {
      const meanDistance = (other: Item[]) => {
        let sum = 0;
        let n = 0;
        for (const o of other) {
          if (o === item) continue;
          sum += 1 - sim(item, o);
          n += 1;
        }
        return n === 0 ? 0 : sum / n;
      };
      const a = meanDistance(group);
      let b = Infinity;
      groups.forEach((other, oi) => {
        if (oi !== gi) b = Math.min(b, meanDistance(other));
      });
      const scale = Math.max(a, b);
      total += scale === 0 ? 0 : (b - a) / scale;
      count += 1;
    }
  });
  return total / count;
}

// `judge` scores a split; with several sources it ignores the artist, because a
// group made of one artist always looks tight and would win over a real mix
function pickClusters(
  items: Item[],
  sim: Sim,
  judge: Sim,
  random: () => number,
  fixed?: number,
): Item[][] {
  if (fixed !== undefined) return cluster(items, fixed, sim, random);
  if (items.length < 6) return [items];
  const most = Math.min(
    MAX_CLUSTERS,
    Math.max(2, Math.round(Math.sqrt(items.length / 1.5))),
  );
  let best: Item[][] = [items];
  let bestScore = -Infinity;
  for (let k = 2; k <= most; k++) {
    const groups = cluster(items, k, sim, random);
    const score = silhouette(groups, judge);
    // a hair of preference for more mixes, so near ties don't collapse to two
    if (score > bestScore) {
      bestScore = score;
      best = groups;
    }
  }
  return best;
}

function label(group: Item[]): string {
  const counts = new Map<string, { name: string; count: number }>();
  for (const { artist, track } of group) {
    const entry = counts.get(artist) ?? {
      name: primaryArtist(track.artists) || track.artists,
      count: 0,
    };
    entry.count += 1;
    counts.set(artist, entry);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((entry) => entry.name)
    .join(" · ");
}

function edge(a: Item, b: Item, sim: Sim): number {
  return sim(a, b) - (a.artist === b.artist ? SAME_ARTIST_PENALTY : 0);
}

// 2-opt: reverses stretches of the path while that makes the walk smoother
function polish(path: Item[], sim: Sim): Item[] {
  if (path.length < 4 || path.length > POLISH_LIMIT) return path;
  const out = [...path];
  for (let pass = 0; pass < 4; pass++) {
    let improved = false;
    for (let i = 0; i < out.length - 2; i++) {
      for (let j = i + 2; j < out.length; j++) {
        const before =
          edge(out[i], out[i + 1], sim) +
          (j + 1 < out.length ? edge(out[j], out[j + 1], sim) : 0);
        const after =
          edge(out[i], out[j], sim) +
          (j + 1 < out.length ? edge(out[i + 1], out[j + 1], sim) : 0);
        if (after > before + 1e-9) {
          out.splice(i + 1, j - i, ...out.slice(i + 1, j + 1).reverse());
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return out;
}

// walks to the nearest unplayed song, stepping off the artist just played
function chain(group: Item[], start: Item, sim: Sim): Item[] {
  const left = new Set(group);
  const out: Item[] = [start];
  left.delete(start);
  let current = start;
  while (left.size > 0) {
    let best: Item | null = null;
    let bestScore = -Infinity;
    for (const candidate of left) {
      const score = edge(current, candidate, sim);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    current = best!;
    left.delete(current);
    out.push(current);
  }
  return polish(out, sim);
}

function shuffled<T>(list: T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// each group is spread evenly over the whole run with a random phase and a
// little jitter, so repeats never bunch up and the pattern never repeats
function dither<T>(groups: T[][], random: () => number): T[] {
  const placed: { position: number; value: T }[] = [];
  for (const group of groups) {
    const phase = random();
    group.forEach((value, index) => {
      const jitter = (random() - 0.5) * 0.4;
      placed.push({
        position: (index + phase + jitter) / group.length,
        value,
      });
    });
  }
  return placed.sort((a, b) => a.position - b.position).map((p) => p.value);
}

// swaps a song with a later one by another artist when two in a row match
function separateArtists(list: Item[]): Item[] {
  const out = [...list];
  for (let i = 1; i < out.length; i++) {
    if (out[i].artist !== out[i - 1].artist) continue;
    const swap = out.findIndex(
      (item, index) =>
        index > i &&
        item.artist !== out[i - 1].artist &&
        item.artist !== out[i + 1]?.artist,
    );
    if (swap > 0) [out[i], out[swap]] = [out[swap], out[i]];
  }
  return out;
}

function orderGroup(
  group: Item[],
  mode: MixMode,
  sim: Sim,
  random: () => number,
) {
  if (mode === "flow") return chain(group, mostCentral(group, sim), sim);
  const byArtist = new Map<string, Item[]>();
  for (const item of shuffled(group, random)) {
    const list = byArtist.get(item.artist) ?? [];
    list.push(item);
    byArtist.set(item.artist, list);
  }
  return separateArtists(dither([...byArtist.values()], random));
}

export function buildSmartMix(
  sources: MixSource[],
  options: MixOptions,
): MixResult {
  const random = options.random ?? Math.random;
  const { items, duplicatesRemoved } = buildItems(sources, options.vibes);
  if (items.length === 0)
    return { clusters: [], combined: [], duplicatesRemoved };
  const sim = similarityMatrix(items);
  const several =
    sources.filter((source) => source.tracks.length > 0).length > 1;
  const measured = items.filter((item) => item.vec).length > items.length / 2;
  const judge = several || measured ? similarityMatrix(items, true) : sim;
  const groups = pickClusters(
    items,
    sim,
    judge,
    random,
    options.clusterCount,
  ).sort((a, b) => b.length - a.length);
  const ordered = groups.map((group) =>
    orderGroup(group, options.mode, sim, random),
  );

  let sequence: Item[][] = ordered;
  let combined: Item[];
  if (options.mode === "flow") {
    // chain the clusters so each one starts nearest to where the last ended
    const remaining = [...ordered];
    sequence = [remaining.shift()!];
    while (remaining.length > 0) {
      const tail = sequence[sequence.length - 1].at(-1)!;
      let bestIndex = 0;
      let bestScore = -1;
      remaining.forEach((group, index) => {
        const score = Math.max(...group.map((item) => sim(tail, item)));
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      });
      const [next] = remaining.splice(bestIndex, 1);
      const start = next.reduce((a, b) =>
        sim(tail, b) > sim(tail, a) ? b : a,
      );
      sequence.push(chain(next, start, sim));
    }
    combined = sequence.flat();
  } else {
    combined = separateArtists(dither(ordered, random));
  }

  const clusters = (options.mode === "flow" ? sequence : ordered).map(
    (group, index) => ({
      id: index,
      label: label(group),
      tracks: group.map((item) => item.track),
    }),
  );
  return {
    clusters,
    combined: combined.map((item) => item.track),
    duplicatesRemoved,
  };
}
