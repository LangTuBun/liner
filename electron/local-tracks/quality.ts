import type { LocalTrackQuality } from "./types.js";

export type QualityVerdict = "better" | "equal" | "worse" | "unknown";

type Rated = LocalTrackQuality & { mimeType?: string };

const direction = (a?: number, b?: number) =>
  a && b ? Math.sign(a - b) : null;

// "unknown" covers missing facts and mixed evidence (more bits but a lower
// rate): the caller then leaves both files alone instead of guessing
export function compareLocalQuality(
  incoming: Rated,
  existing: Rated,
): QualityVerdict {
  if (incoming.lossless === undefined || existing.lossless === undefined)
    return "unknown";
  if (incoming.lossless !== existing.lossless)
    return incoming.lossless ? "better" : "worse";

  if (incoming.lossless) {
    const moves = [
      direction(incoming.bitDepth, existing.bitDepth),
      direction(incoming.sampleRate, existing.sampleRate),
    ].filter((move): move is number => move !== null);
    if (moves.length === 0) return "unknown";
    const up = moves.some((move) => move > 0);
    const down = moves.some((move) => move < 0);
    if (up && down) return "unknown";
    return up ? "better" : down ? "worse" : "equal";
  }

  // bitrates only compare inside one codec
  if (!incoming.bitrate || !existing.bitrate) return "unknown";
  if (incoming.mimeType !== existing.mimeType) return "unknown";
  const ratio = incoming.bitrate / existing.bitrate;
  return ratio > 1.1 ? "better" : ratio < 0.9 ? "worse" : "equal";
}
