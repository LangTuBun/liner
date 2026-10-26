import type { AttachedSourceInfo } from "@/features/player/engine/playbackStream";
import type { LocalAudioFormat } from "../../../../electron/local-tracks/metadata";
import type { OutputEndpoint } from "../../../../electron/audio-quality/endpoints";

export type { LocalAudioFormat, OutputEndpoint };

const LOSSLESS_CODECS = new Set([
  "flac",
  "alac",
  "wavpack",
  "ape",
  "tta",
  "pcm",
]);

interface ItagFormat {
  codec: string;
  profile: string;
  sampleRate: number;
  nominalKbps: number;
}

// youtube audio itags. Opus always decodes at 48 kHz, AAC-LC at 44.1 kHz
export const YT_ITAGS: Record<number, ItagFormat> = {
  139: { codec: "aac", profile: "HE-AAC", sampleRate: 22050, nominalKbps: 48 },
  140: { codec: "aac", profile: "AAC-LC", sampleRate: 44100, nominalKbps: 128 },
  141: { codec: "aac", profile: "AAC-LC", sampleRate: 44100, nominalKbps: 256 },
  249: { codec: "opus", profile: "", sampleRate: 48000, nominalKbps: 50 },
  250: { codec: "opus", profile: "", sampleRate: 48000, nominalKbps: 70 },
  251: { codec: "opus", profile: "", sampleRate: 48000, nominalKbps: 160 },
  774: { codec: "opus", profile: "", sampleRate: 48000, nominalKbps: 256 },
};

export interface SourceSummary {
  origin: AttachedSourceInfo["origin"];
  codec: string;
  profile: string;
  container: string;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  bitrate: number | null;
  lossless: boolean;
}

export function isLosslessCodec(codec: string): boolean {
  const c = codec.toLowerCase();
  return LOSSLESS_CODECS.has(c) || c.startsWith("pcm");
}

function codecFromMime(mimeType: string): string {
  const quoted = mimeType.match(/codecs="?([^",;]+)/i);
  if (quoted) {
    const codec = quoted[1].toLowerCase();
    return codec.startsWith("mp4a") ? "aac" : codec;
  }
  if (/mpeg/i.test(mimeType)) return "mp3";
  return "";
}

function containerFromMime(mimeType: string): string {
  const match = mimeType.match(/^audio\/([\w.+-]+)/i);
  if (!match) return "";
  const kind = match[1].toLowerCase();
  return kind === "mp4" ? "m4a" : kind;
}

const NOMINAL_RATE: Record<string, number> = {
  opus: 48000,
  aac: 44100,
  mp3: 44100,
};

// local files are probed for real; streams are read from the format youtube /
// soundcloud announced, with the decode rate implied by the codec
export function summarizeSource(
  info: AttachedSourceInfo | null,
  local: LocalAudioFormat | null,
  durationSec: number,
): SourceSummary | null {
  if (!info) return null;
  if (info.origin === "local") {
    if (!local) return null;
    const codec = local.codec.split(/\s/)[0].toLowerCase();
    return {
      origin: info.origin,
      codec: local.codec,
      profile: local.codecProfile,
      container: local.container,
      sampleRate: local.sampleRate,
      bitDepth: local.bitDepth,
      channels: local.channels,
      bitrate: local.bitrate,
      lossless: local.lossless || isLosslessCodec(codec),
    };
  }
  const itag = info.itag ? YT_ITAGS[info.itag] : undefined;
  const codec = (
    itag?.codec ||
    (info.codec && info.codec !== "local" ? info.codec : "") ||
    codecFromMime(info.mimeType)
  ).toLowerCase();
  const measured =
    info.contentLength && durationSec > 0
      ? Math.round((info.contentLength * 8) / durationSec)
      : null;
  return {
    origin: info.origin,
    codec,
    profile: itag?.profile ?? "",
    container: containerFromMime(info.mimeType),
    sampleRate: itag?.sampleRate ?? NOMINAL_RATE[codec] ?? null,
    bitDepth: null,
    channels: null,
    bitrate: measured || info.bitrate || null,
    lossless: isLosslessCodec(codec),
  };
}

// highest frequency with real content: lossy encoders low-pass the signal well
// below the nyquist, so where the spectrum falls off says a lot about the source
export function estimateBandwidth(
  dbBins: ArrayLike<number>,
  sampleRate: number,
): number | null {
  if (!dbBins.length || !sampleRate) return null;
  const n = dbBins.length;
  const hzPerBin = sampleRate / 2 / n;
  const lo = Math.max(1, Math.floor(1000 / hzPerBin));
  const hi = Math.min(n - 1, Math.floor(6000 / hzPerBin));
  let ref = 0;
  let count = 0;
  for (let i = lo; i <= hi; i++) {
    if (Number.isFinite(dbBins[i])) {
      ref += dbBins[i];
      count++;
    }
  }
  if (!count) return null;
  ref /= count;
  if (ref < -110) return null;
  const floor = Math.max(ref - 55, -125);
  for (let i = n - 1; i > hi; i--) {
    let run = 0;
    for (let j = i; j > i - 4 && j > hi; j--) {
      if (dbBins[j] > floor) run++;
    }
    if (run >= 3) return Math.round((i + 0.5) * hzPerBin);
  }
  return Math.round(hi * hzPerBin);
}

export type BandwidthVerdict =
  "full" | "wide" | "high_lossy" | "lossy" | "low_lossy";

export function bandwidthVerdict(
  cutoffHz: number | null,
  sampleRate: number,
): BandwidthVerdict | null {
  if (!cutoffHz) return null;
  if (cutoffHz >= (sampleRate / 2) * 0.97) return "full";
  if (cutoffHz < 15500) return "low_lossy";
  if (cutoffHz < 19000) return "lossy";
  if (cutoffHz < 21000) return "high_lossy";
  return "wide";
}

// chromium labels the default device "Default - Speakers (Realtek(R) Audio)"
export function matchEndpoint(
  label: string,
  endpoints: OutputEndpoint[],
): OutputEndpoint | null {
  const clean = label
    .replace(/^(Default|Communications)\s*[-–—:]\s*/i, "")
    .trim()
    .toLowerCase();
  if (!clean || endpoints.length === 0) return null;
  return (
    endpoints.find((e) => e.label.toLowerCase() === clean) ??
    endpoints.find((e) => e.label && clean.startsWith(e.label.toLowerCase())) ??
    endpoints.find(
      (e) =>
        e.name &&
        e.iface &&
        clean.includes(e.name.toLowerCase()) &&
        clean.includes(e.iface.toLowerCase()),
    ) ??
    null
  );
}

export function formatRate(hz: number | null | undefined): string {
  if (!hz) return "—";
  const k = hz / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
}

export function formatKbps(bps: number | null | undefined): string {
  return bps ? `${Math.round(bps / 1000)} kbps` : "—";
}

export function toDb(value: number): number {
  return value > 0 ? 20 * Math.log10(value) : -Infinity;
}
