// audio a stream gave us, written to disk with an extension the library takes
const EXTENSION_BY_STREAM_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

// a hard stop so a bad response can't fill the disk; a long song is ~15 MB
export const MAX_STREAM_BYTES = 200 * 1024 * 1024;

export function extensionForMime(mimeType: string): string | null {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  return EXTENSION_BY_STREAM_MIME[base] ?? null;
}
