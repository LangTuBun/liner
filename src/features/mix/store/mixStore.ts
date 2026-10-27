import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Track } from "@/shared/types";

export interface SavedMix {
  id: string;
  name: string;
  createdAt: number;
  tracks: Track[];
}

interface MixState {
  mixes: SavedMix[];
  save: (name: string, tracks: Track[]) => void;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  removeTrack: (id: string, trackId: string) => void;
}

// device-only: a mix can hold downloaded files, which a server playlist can't
export const useMixStore = create<MixState>()(
  persist(
    (set) => ({
      mixes: [],
      save: (name, tracks) =>
        set((state) => ({
          mixes: [
            {
              id: `mix-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              name,
              createdAt: Date.now(),
              tracks,
            },
            ...state.mixes,
          ],
        })),
      rename: (id, name) =>
        set((state) => ({
          mixes: state.mixes.map((mix) =>
            mix.id === id ? { ...mix, name } : mix,
          ),
        })),
      removeTrack: (id, trackId) =>
        set((state) => ({
          mixes: state.mixes.map((mix) =>
            mix.id === id
              ? { ...mix, tracks: mix.tracks.filter((t) => t.id !== trackId) }
              : mix,
          ),
        })),
      remove: (id) =>
        set((state) => ({ mixes: state.mixes.filter((mix) => mix.id !== id) })),
    }),
    { name: "liner_smart_mixes_v1" },
  ),
);
