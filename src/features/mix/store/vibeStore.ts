import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isLocalTrackId, localFileId } from "@/shared/media/local";
import type { Track } from "@/shared/types";
import { analyzeLocalTrack, type Vibe } from "../lib/vibe";

interface VibeState {
  // by local file id; null means the file could not be analyzed
  vibes: Record<string, Vibe | null>;
  analyze: (
    tracks: Track[],
    onProgress?: (done: number, total: number) => void,
  ) => Promise<void>;
}

const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// measured once per file and kept, so the next mix starts at once
export const useVibeStore = create<VibeState>()(
  persist(
    (set, get) => ({
      vibes: {},
      analyze: async (tracks, onProgress) => {
        const todo = tracks
          .filter((track) => isLocalTrackId(track.id))
          .map((track) => localFileId(track.id))
          .filter((id) => get().vibes[id] === undefined);
        let done = 0;
        for (const id of todo) {
          onProgress?.(done, todo.length);
          let vibe: Vibe | null = null;
          try {
            vibe = await analyzeLocalTrack(id);
          } catch {}
          set((state) => ({ vibes: { ...state.vibes, [id]: vibe } }));
          done += 1;
          await nextFrame();
        }
        onProgress?.(done, todo.length);
      },
    }),
    { name: "liner_vibe_v1" },
  ),
);

// the measured vibe of each local track, keyed by track id
export function vibesFor(tracks: Track[]): Map<string, Vibe> {
  const { vibes } = useVibeStore.getState();
  const out = new Map<string, Vibe>();
  for (const track of tracks) {
    if (!isLocalTrackId(track.id)) continue;
    const vibe = vibes[localFileId(track.id)];
    if (vibe) out.set(track.id, vibe);
  }
  return out;
}
