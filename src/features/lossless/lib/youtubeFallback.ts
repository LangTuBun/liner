import { resolvePlaybackStream } from "@/features/player/engine/streamResolver";
import { downloadAudioBytes } from "@/shared/youtube/innertube/chunkedAudioDownload";
import type { LosslessDownloadRequest } from "../../../../electron/lossless/types";

const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;

// "Opus · 130 kbps": what was saved, for the download list
function describeStream(stream: {
  codec: string;
  mimeType: string;
  bitrate: number;
}): string {
  const codec = stream.codec.toLowerCase();
  const name = codec.includes("opus")
    ? "Opus"
    : codec.includes("mp4a") || stream.mimeType.includes("mp4")
      ? "AAC"
      : codec.split(".")[0].toUpperCase();
  const kbps = stream.bitrate > 0 ? Math.round(stream.bitrate / 1000) : 0;
  return kbps ? `${name} · ${kbps} kbps` : name;
}

// saves the song from the same stream the player would use, at the best quality
// that stream offers, when Soulseek has no copy
export async function saveFromYoutube(
  request: LosslessDownloadRequest,
): Promise<{ localId: string; quality: string }> {
  const bridge = window.linerElectron;
  if (!bridge?.losslessImportStream)
    throw new Error("Saving needs the desktop app");
  if (!request.trackId) throw new Error("No song to look up");
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);

  const stream = await resolvePlaybackStream(
    {
      id: request.trackId,
      title: request.title,
      artists: request.artist,
      durationMs: request.durationMs ?? 0,
    },
    signal,
  );
  if (stream.origin === "local") throw new Error("Already on this device");

  const bytes = stream.blob
    ? new Uint8Array(await stream.blob.arrayBuffer())
    : await downloadAudioBytes(stream.url, {
        contentLength: stream.contentLength,
        signal,
      });
  stream.release?.();
  if (!bytes || bytes.byteLength === 0) throw new Error("No audio came back");

  const saved = await bridge.losslessImportStream({
    bytes,
    mimeType: stream.mimeType,
    title: request.title,
    artist: request.artist,
    album: request.album,
    thumbnail: request.thumbnail,
  });
  return { localId: saved.localId, quality: describeStream(stream) };
}
