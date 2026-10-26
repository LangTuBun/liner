import { DownloadLine } from "@mingcute/react";
import type { DropdownMenuItem } from "@/shared/ui/DropdownMenu";
import type { Track } from "@/shared/types";
import { isLocalTrackId } from "@/shared/media/local";
import { useLosslessStore } from "../store/losslessStore";

// "download lossless" for every catalog track of a playlist or album; null
// outside the desktop app or when nothing can be downloaded
export function losslessBatchMenuItem(
  tracks: Track[],
  name: string,
  label: string,
): DropdownMenuItem | null {
  if (typeof window === "undefined" || !window.linerElectron) return null;
  const requests = tracks
    .filter((track) => !isLocalTrackId(track.id) && track.title)
    .map((track) => ({
      title: track.title,
      artist: track.artists,
      album: track.album?.title,
      durationMs: track.durationMs,
      thumbnail: track.coverUrl,
    }));
  if (requests.length === 0) return null;
  return {
    id: "download-lossless",
    label,
    icon: <DownloadLine size={15} />,
    onClick: () => {
      void useLosslessStore.getState().downloadBatch(requests, name);
    },
  };
}
