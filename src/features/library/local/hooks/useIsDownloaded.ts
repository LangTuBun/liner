import { useEffect } from "react";
import {
  downloadedTrackKey,
  useLocalLibraryStore,
} from "../store/localLibraryStore";

// true when a file for this catalog song is already saved on this device
export function useIsDownloaded(track: {
  id?: string;
  title?: string;
  artists?: string;
}): boolean {
  const key = downloadedTrackKey(track);
  const load = useLocalLibraryStore((state) => state.load);
  const idle = useLocalLibraryStore((state) => state.loadState === "idle");
  useEffect(() => {
    if (idle) void load();
  }, [idle, load]);
  return useLocalLibraryStore((state) =>
    key ? state.downloadIndex.has(key) : false,
  );
}
