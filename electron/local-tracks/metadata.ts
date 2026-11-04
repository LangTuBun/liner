import path from "node:path";
import { parseFile } from "music-metadata";
import type { LocalTrackQuality } from "./types.js";

export interface LocalTrackTags {
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  mimeType: string;
  trackNo?: number;
  discNo?: number;
  quality: LocalTrackQuality;
  cover?: { data: Uint8Array; extension: string };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  webm: "audio/webm",
};

const positive = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;

const EXTENSION_BY_IMAGE_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function audioExtension(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

export function mimeTypeFor(filePath: string): string {
  return (
    MIME_BY_EXTENSION[audioExtension(filePath)] ?? "application/octet-stream"
  );
}

function namesFromFileName(filePath: string): {
  title: string;
  artist: string;
} {
  const base = path.basename(filePath, path.extname(filePath)).trim();
  const cleaned = base.replace(/^\d{1,3}[\s.\-_]+/, "").trim() || base;
  const separator = cleaned.indexOf(" - ");
  if (separator > 0) {
    return {
      artist: cleaned.slice(0, separator).trim(),
      title: cleaned.slice(separator + 3).trim(),
    };
  }
  return { title: cleaned, artist: "" };
}

export async function readLocalTrackTags(
  filePath: string,
): Promise<LocalTrackTags> {
  const fallback = namesFromFileName(filePath);
  const mimeType = mimeTypeFor(filePath);
  try {
    const { common, format } = await parseFile(filePath, { duration: true });
    const picture = common.picture?.[0];
    const coverExtension = picture
      ? EXTENSION_BY_IMAGE_MIME[picture.format.toLowerCase()]
      : undefined;
    return {
      title: common.title?.trim() || fallback.title,
      artist:
        common.artists?.join(", ").trim() ||
        common.artist?.trim() ||
        fallback.artist,
      ...(common.album?.trim() ? { album: common.album.trim() } : {}),
      durationMs: Math.round((format.duration ?? 0) * 1000),
      mimeType,
      ...(positive(common.track.no) ? { trackNo: common.track.no! } : {}),
      ...(positive(common.disk.no) ? { discNo: common.disk.no! } : {}),
      quality: {
        ...(format.lossless === undefined ? {} : { lossless: format.lossless }),
        ...(positive(format.bitsPerSample)
          ? { bitDepth: format.bitsPerSample! }
          : {}),
        ...(positive(format.sampleRate)
          ? { sampleRate: format.sampleRate! }
          : {}),
        ...(positive(format.bitrate) ? { bitrate: format.bitrate! } : {}),
      },
      ...(picture && coverExtension
        ? { cover: { data: picture.data, extension: coverExtension } }
        : {}),
    };
  } catch {
    return { ...fallback, durationMs: 0, mimeType, quality: {} };
  }
}

export interface LocalAudioFormat {
  container: string;
  codec: string;
  codecProfile: string;
  lossless: boolean;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  bitrate: number | null;
  durationSec: number | null;
}

export async function probeLocalAudio(
  filePath: string,
): Promise<LocalAudioFormat> {
  const { format } = await parseFile(filePath, {
    duration: true,
    skipCovers: true,
  });
  const lossless = Boolean(format.lossless);
  return {
    container: format.container ?? "",
    codec: format.codec ?? "",
    codecProfile: format.codecProfile ?? "",
    lossless,
    sampleRate: positive(format.sampleRate) ?? null,
    bitDepth: lossless ? (positive(format.bitsPerSample) ?? null) : null,
    channels: positive(format.numberOfChannels) ?? null,
    bitrate: positive(format.bitrate) ?? null,
    durationSec: positive(format.duration) ?? null,
  };
}
