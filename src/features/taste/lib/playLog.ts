import { usePlayerStore } from "@/features/player/store/playerStore";
import { artistKey, KEPT_AFTER_MS, type TastePlay } from "./tasteModel";

const KEY = "liner_taste_log_v1";
/** the oldest plays go first */
export const LOG_LIMIT = 5000;
/** a pause longer than this starts a fresh listening run, with no "previous" artist */
const SESSION_GAP_MS = 30 * 60 * 1000;

export function readPlays(): TastePlay[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as TastePlay[]) : [];
  } catch {
    return [];
  }
}

function writePlays(plays: TastePlay[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(plays.slice(-LOG_LIMIT)));
  } catch {
    // shortcut: a full or blocked store just stops learning, upgrade to the saved-tracks db if logs need to survive that
  }
}

/** logs each track as kept (listened 30 s or half) or skipped when the next one starts */
export function initTasteLog() {
  let current: { artist: string; durationMs: number; at: number } | null = null;
  let prev = "";
  let peakMs = 0;
  let lastEndedAt = 0;

  usePlayerStore.subscribe((state, before) => {
    if (state.currentTrack?.id === before.currentTrack?.id) {
      if (state.positionMs > peakMs) peakMs = state.positionMs;
      return;
    }
    const now = Date.now();
    if (current) {
      const durationMs = current.durationMs || before.durationMs;
      const kept =
        peakMs >= KEPT_AFTER_MS || (durationMs > 0 && peakMs >= durationMs / 2);
      // a track cut off in under 2 s was never really started
      if (peakMs >= 2000) {
        writePlays([
          ...readPlays(),
          {
            at: current.at,
            artist: current.artist,
            prev: now - lastEndedAt > SESSION_GAP_MS ? "" : prev,
            durationMs,
            kept,
          },
        ]);
        prev = current.artist;
        lastEndedAt = now;
      }
    }
    const track = state.currentTrack;
    current = track
      ? {
          artist: artistKey(track),
          durationMs: track.durationMs,
          at: now,
        }
      : null;
    peakMs = 0;
  });
}
