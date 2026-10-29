import { create } from "zustand";
import {
  isLocalTrackId,
  localRecordToTrack,
  toLocalTrackId,
  type LocalImportResult,
  type LocalTrackRecord,
} from "@/shared/media/local";
import { linerDb } from "@/shared/storage/linerDb";
import { lyricsCache } from "@/features/lyrics";
import type { Track } from "@/shared/types";
import { recordMatchKey, trackMatchKey } from "../lib/downloadMatch";

type LoadState = "idle" | "loading" | "ready" | "unavailable";

interface LocalLibraryState {
  records: LocalTrackRecord[];
  tracks: Track[];
  // match key of a song -> local track id of the file saved for it
  downloadIndex: Map<string, string>;
  loadState: LoadState;
  importing: boolean;
  load: () => Promise<void>;
  importPaths: (paths: string[]) => Promise<LocalImportResult | null>;
  pickFiles: () => Promise<LocalImportResult | null>;
  remove: (fileIds: string[]) => Promise<void>;
}

const newestFirst = (records: LocalTrackRecord[]) =>
  [...records].sort((a, b) => b.addedAt - a.addedAt);

const withTracks = (records: LocalTrackRecord[]) => {
  const sorted = newestFirst(records);
  const downloadIndex = new Map<string, string>();
  for (const record of sorted) {
    const key = recordMatchKey(record);
    if (key && !downloadIndex.has(key))
      downloadIndex.set(key, toLocalTrackId(record.id));
  }
  return {
    records: sorted,
    tracks: sorted.map(localRecordToTrack),
    downloadIndex,
  };
};

export function downloadedTrackKey(track: {
  id?: string;
  title?: string;
  artists?: string;
}): string | null {
  if (!track.id || isLocalTrackId(track.id)) return null;
  return trackMatchKey(track.title, track.artists);
}

// local track id of the file saved for a catalog song, once the library is loaded
export async function findDownloadedTrackId(track: {
  id?: string;
  title?: string;
  artists?: string;
}): Promise<string | null> {
  const key = downloadedTrackKey(track);
  if (!key) return null;
  const state = useLocalLibraryStore.getState();
  if (state.loadState === "idle") await state.load();
  return useLocalLibraryStore.getState().downloadIndex.get(key) ?? null;
}

export const useLocalLibraryStore = create<LocalLibraryState>((set, get) => {
  // tracks the main process adds on its own (the riff migration)
  if (typeof window !== "undefined")
    window.linerElectron?.onLocalTracksChanged?.(() => {
      if (get().loadState !== "idle") void get().load();
    });

  const runImport = async (
    request: () => Promise<LocalImportResult | null>,
  ): Promise<LocalImportResult | null> => {
    set({ importing: true });
    try {
      const result = await request();
      if (result && result.added.length > 0) {
        set(withTracks([...get().records, ...result.added]));
      }
      return result;
    } finally {
      set({ importing: false });
    }
  };

  return {
    records: [],
    tracks: [],
    downloadIndex: new Map(),
    loadState: "idle",
    importing: false,

    load: async () => {
      const bridge = window.linerElectron;
      if (!bridge) {
        set({ loadState: "unavailable" });
        return;
      }
      if (get().loadState === "loading") return;
      set({ loadState: "loading" });
      try {
        set({
          ...withTracks(await bridge.localTracksList()),
          loadState: "ready",
        });
      } catch {
        set({ loadState: "ready" });
      }
    },

    importPaths: (paths) => {
      const bridge = window.linerElectron;
      if (!bridge || paths.length === 0) return Promise.resolve(null);
      return runImport(() => bridge.localTracksImport(paths));
    },

    pickFiles: () => {
      const bridge = window.linerElectron;
      if (!bridge) return Promise.resolve(null);
      return runImport(() => bridge.localTracksPick());
    },

    remove: async (fileIds) => {
      const bridge = window.linerElectron;
      if (!bridge || fileIds.length === 0) return;
      const removing = new Set(fileIds);
      set(
        withTracks(get().records.filter((record) => !removing.has(record.id))),
      );
      await bridge.localTracksRemove(fileIds);
      const trackIds = fileIds.map(toLocalTrackId);
      for (const trackId of trackIds) lyricsCache.delete(trackId);
      await linerDb.deleteLyrics(trackIds);
    },
  };
});
