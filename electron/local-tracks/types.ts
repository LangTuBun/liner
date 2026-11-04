export interface LocalTrackQuality {
  lossless?: boolean;
  bitDepth?: number;
  sampleRate?: number;
  bitrate?: number;
}

export interface LocalTrackRecord extends LocalTrackQuality {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  fileName: string;
  audioFile: string;
  mimeType: string;
  coverFile?: string;
  trackNo?: number;
  discNo?: number;
  // hash of the file last imported; id stays put when a better copy replaces it
  contentHash?: string;
  byteSize: number;
  addedAt: number;
  // set on lossless downloads from soulseek
  source?: "soulseek" | "youtube";
  matchKey?: string;
  hiRes?: "hires" | "upsampled" | "unknown" | null;
}

export type LocalTrackPatch = Partial<
  Pick<
    LocalTrackRecord,
    "source" | "matchKey" | "hiRes" | "title" | "artist" | "addedAt"
  >
>;
export interface LocalLibraryUsage {
  count: number;
  bytes: number;
}

export interface LocalImportResult {
  added: LocalTrackRecord[];
  duplicates: number;
  failed: string[];
  // tracks whose file was swapped for a better copy, and copies left out
  upgraded?: LocalTrackRecord[];
  kept?: number;
}

export const LOCAL_AUDIO_EXTENSIONS = [
  "mp3",
  "flac",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "wav",
  "webm",
  "dsf",
] as const;
