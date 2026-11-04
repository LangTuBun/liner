import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { collectionPath } from "@/features/collection/lib/collectionPreview";
import { useModalStore } from "@/features/library";
import { playerEngine } from "@/features/player";
import { useTranslation } from "@/languages";
import { HERO_BUTTON_CLASS, showToast } from "@/shared/ui";
import Button from "@/shared/ui/Button";
import type { LocalAlbum } from "../lib/albums";
import { findCatalogAlbum } from "../lib/linkAlbum";
import { useLocalLibraryStore } from "../store/localLibraryStore";

function play(album: LocalAlbum) {
  playerEngine.clearQueue();
  void playerEngine.playTrack(album.tracks[0], album.tracks, album.title);
}

export default function LocalAlbumList({ albums }: { albums: LocalAlbum[] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const stamp = useLocalLibraryStore((state) => state.stamp);
  const [busy, setBusy] = useState<string | null>(null);

  // Opens the online album with this device's files tied to its songs, so
  // every row plays from here and the usual add-to-library dialog is one tap
  const addToLibrary = async (album: LocalAlbum) => {
    setBusy(album.key);
    try {
      const link = await findCatalogAlbum(album);
      if (!link) {
        showToast(t("library.local.album_not_found"), "info", {
          description: album.title,
        });
        return;
      }
      await stamp(link.stamps);
      navigate(collectionPath("album", link.albumId));
      useModalStore.getState().openAddToLibrary({
        id: link.albumId,
        title: link.title,
        coverUrl: link.coverUrl,
        type: "album",
      });
    } catch {
      showToast(t("library.local.album_lookup_failed"), "error");
    } finally {
      setBusy(null);
    }
  };

  if (albums.length === 0)
    return (
      <p className="m-0 p-[24px] text-center text-body text-text-tertiary">
        {t("library.local.albums_empty")}
      </p>
    );

  return (
    <div className="flex flex-col gap-[4px]">
      {albums.map((album) => (
        <div
          key={album.key}
          className="flex items-center gap-[14px] rounded-[12px] p-[8px]"
        >
          <div className="size-[56px] shrink-0 overflow-hidden rounded-[8px] bg-fill">
            {album.coverUrl && (
              <img
                src={album.coverUrl}
                alt=""
                className="size-full object-cover"
                draggable={false}
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="m-0 truncate text-title font-[500] text-text-primary">
              {album.title}
            </p>
            <p className="m-0 truncate text-body text-text-tertiary">
              {album.artist} ·{" "}
              {t("library.local.album_songs", { count: album.tracks.length })}
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={() => play(album)}
            className={`${HERO_BUTTON_CLASS} px-[16px]`}
          >
            {t("library.local.album_play")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void addToLibrary(album)}
            disabled={busy !== null}
            className={`${HERO_BUTTON_CLASS} px-[16px]`}
          >
            {busy === album.key
              ? t("library.local.album_finding")
              : t("library.local.album_add")}
          </Button>
        </div>
      ))}
    </div>
  );
}
