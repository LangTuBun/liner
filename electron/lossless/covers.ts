import { nativeImage } from "electron";
import { parseFile } from "music-metadata";
import {
  maxItunesArtwork,
  pickBestCover,
  type CoverCandidate,
} from "./query.js";

export interface CoverImage extends CoverCandidate {
  data: Buffer;
  mimeType: string;
}

// itunes rate-limits bursts, so playlist downloads ask one track at a time
const ITUNES_GAP_MS = 3_000;
let itunesChain: Promise<unknown> = Promise.resolve();
let lastItunesAt = 0;

function spaced<T>(task: () => Promise<T>): Promise<T> {
  const next = itunesChain.then(async () => {
    const wait = lastItunesAt + ITUNES_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastItunesAt = Date.now();
    return task();
  });
  itunesChain = next.catch(() => undefined);
  return next;
}

async function findItunesArtwork(
  artist: string,
  title: string,
): Promise<string> {
  if (!title) return "";
  const term = encodeURIComponent(`${artist} ${title}`.trim());
  const res = await spaced(() =>
    fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=10`, {
      signal: AbortSignal.timeout(8000),
    }),
  );
  if (!res.ok) return "";
  const data = (await res.json()) as {
    results?: Array<{
      artistName?: string;
      trackName?: string;
      artworkUrl100?: string;
    }>;
  };
  const wantArtist = artist.toLowerCase();
  const wantTitle = title.toLowerCase();
  const results = (data.results ?? []).filter((r) => r.artworkUrl100);
  const byArtist = (r: (typeof results)[number]) =>
    !wantArtist ||
    String(r.artistName ?? "")
      .toLowerCase()
      .includes(wantArtist);
  const match =
    results.find(
      (r) =>
        byArtist(r) &&
        String(r.trackName ?? "")
          .toLowerCase()
          .startsWith(wantTitle),
    ) ?? results.find(byArtist);
  return match?.artworkUrl100 ? maxItunesArtwork(match.artworkUrl100) : "";
}

function sniffMime(data: Buffer): string | null {
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data.subarray(0, 4).toString("latin1") === "\x89PNG") return "image/png";
  return null;
}

function measure(
  data: Buffer,
  source: CoverImage["source"],
  rank: number,
): CoverImage | null {
  const mimeType = sniffMime(data);
  if (!mimeType) return null;
  const { width, height } = nativeImage.createFromBuffer(data).getSize();
  return width && height
    ? { data, mimeType, width, height, source, rank }
    : null;
}

async function download(url: string): Promise<Buffer | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const data = Buffer.from(await res.arrayBuffer());
  return data.length > 500 ? data : null;
}

// the largest picture among the embedded art, the itunes original and the
// thumbnail the stream showed
export async function findBestCover(
  filePath: string,
  hint: { artist: string; title: string; thumbnail?: string },
): Promise<CoverImage | null> {
  const candidates: CoverImage[] = [];
  try {
    const { common } = await parseFile(filePath, { skipPostHeaders: true });
    const picture = common.picture?.[0];
    const embedded = picture
      ? measure(Buffer.from(picture.data), "embedded", 1)
      : null;
    if (embedded) candidates.push(embedded);
  } catch {}
  try {
    const url = await findItunesArtwork(hint.artist, hint.title);
    const data = url ? await download(url) : null;
    const itunes = data ? measure(data, "itunes", 0) : null;
    if (itunes) candidates.push(itunes);
  } catch {}
  if (hint.thumbnail && /^https:\/\//i.test(hint.thumbnail)) {
    try {
      const data = await download(hint.thumbnail);
      const stream = data ? measure(data, "stream", 2) : null;
      if (stream) candidates.push(stream);
    } catch {}
  }
  return pickBestCover(candidates);
}
