// flac and wav only: Chromium plays both and the local library imports both
export const LOSSLESS_FORMATS = ["flac", "wav"] as const;

export interface LosslessTrackInput {
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  // youtube uploads carry channel names and video lengths that can differ from
  // the release, so the search must not insist on them
  artistMaybeWrong?: boolean;
  lengthUnreliable?: boolean;
}

export interface SoulseekSongQuery {
  artist: string | null;
  title: string | null;
  album: string | null;
  uri: null;
  length: number | null;
  artistMaybeWrong: boolean;
}

const NOISE_IN_BRACKETS =
  /\s*[([][^)\]]*\b(feat\.?|ft\.?|featuring|official|audio|video|lyrics?|visuali[sz]er|hd|hq|4k|mv|m\/v)\b[^)\]]*[)\]]/gi;

export function primaryArtist(artist: string | undefined): string {
  let a = String(artist ?? "")
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\s+(feat\.?|ft\.?|featuring|with)\s+.*$/i, "")
    .trim();
  if (a.includes(",")) a = a.split(",")[0].trim();
  if (a.includes(";")) a = a.split(";")[0].trim();
  return a.replace(/\s+x\s+.*$/i, "").trim();
}

export function cleanTitle(title: string | undefined): string {
  return String(title ?? "")
    .replace(NOISE_IN_BRACKETS, "")
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanSoulseekQuery(
  track: LosslessTrackInput,
): SoulseekSongQuery {
  let artist = primaryArtist(track.artist);
  let title = cleanTitle(track.title);
  if (!artist && title.includes(" - ")) {
    const i = title.indexOf(" - ");
    artist = title.slice(0, i).trim();
    title = title.slice(i + 3).trim();
  }
  const seconds = Math.round(Number(track.durationSec) || 0);
  return {
    artist: artist || null,
    title: title || null,
    album: track.album?.trim() || null,
    uri: null,
    length: seconds > 0 && !track.lengthUnreliable ? seconds : null,
    artistMaybeWrong: Boolean(track.artistMaybeWrong),
  };
}

export function queryKey(query: SoulseekSongQuery): string {
  return `${query.artist ?? ""}\u0000${query.title ?? ""}`.toLowerCase();
}

export function buildSongJobRequest(
  query: SoulseekSongQuery,
  options: { preferHiRes?: boolean } = {},
) {
  const preferredCond: Record<string, number> = { lengthTolerance: 3 };
  if (options.preferHiRes) {
    Object.assign(preferredCond, {
      minBitDepth: 24,
      minSampleRate: 88200,
      maxSampleRate: 384000,
      maxBitrate: 20000,
    });
  }
  return {
    songQuery: query,
    options: {
      outputParentDir: null,
      downloadSettings: {
        search: {
          necessaryCond: {
            formats: { replace: [...LOSSLESS_FORMATS] },
            lengthTolerance: 15,
          },
          preferredCond,
        },
        ytDlp: { useYtdlp: false },
        skip: { skipExisting: false },
      },
    },
    downloadBehavior: { default: "Automatic" },
  };
}

function confValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("value must be a single line");
  return `"${value}"`;
}

// sockseek splits a line on the first "=" and strips surrounding quotes
export function buildSockseekConf(auth: {
  username: string;
  password: string;
}): string {
  if (!auth.username || !auth.password)
    throw new Error("username and password are required");
  return [
    "# written by Liner, do not edit",
    `username = ${confValue(auth.username)}`,
    `password = ${confValue(auth.password)}`,
    "",
  ].join("\n");
}

export function isLosslessExtension(ext: string): boolean {
  return (LOSSLESS_FORMATS as readonly string[]).includes(
    ext.replace(/^\./, "").toLowerCase(),
  );
}

export function maxItunesArtwork(url: string): string {
  return /\/\d+x\d+bb\.(jpg|png)$/i.test(url)
    ? url.replace(/\/\d+x\d+bb\.(jpg|png)$/i, "/3000x3000bb-100.jpg")
    : url;
}

export interface CoverCandidate {
  source: "embedded" | "itunes" | "stream";
  width: number;
  height: number;
  rank: number;
}

// largest picture wins; on a tie the lower rank (the better source) wins
export function pickBestCover<T extends CoverCandidate>(
  candidates: T[],
): T | null {
  const usable = candidates.filter((c) => c.width > 0 && c.height > 0);
  usable.sort(
    (a, b) => b.width * b.height - a.width * a.height || a.rank - b.rank,
  );
  return usable[0] ?? null;
}

export type HiResVerdict = "hires" | "upsampled" | "unknown";

// band levels in dBFS just below (17-21 kHz) and just above (24-30 kHz) the CD
// nyquist, plus the ultrasonic band (30-40 kHz) when the file reaches it. An
// upsample from 44.1/48 kHz leaves at most resampler residue above 22 kHz and
// digital silence further up, where a real hi-res recording still has noise
const ULTRASONIC_SILENCE_DB = -125;

export function classifyUltrasonic(
  below: number,
  above: number,
  ultrasonic?: number,
): HiResVerdict {
  if (!Number.isFinite(below) || below < -100) return "unknown";
  if (!Number.isFinite(above)) return "upsampled";
  if (below - above >= 40) return "upsampled";
  if (
    ultrasonic !== undefined &&
    (!Number.isFinite(ultrasonic) || ultrasonic < ULTRASONIC_SILENCE_DB)
  )
    return "upsampled";
  return "hires";
}
