import { playerEngine } from "@/features/player";
import { useMixStore } from "@/features/mix/store/mixStore";
import { useTranslation } from "@/languages";
import { HERO_BUTTON_CLASS, showToast } from "@/shared/ui";
import Button from "@/shared/ui/Button";
import type { LocalAlbum } from "../lib/albums";

function play(album: LocalAlbum) {
  playerEngine.clearQueue();
  void playerEngine.playTrack(album.tracks[0], album.tracks, album.title);
}

export default function LocalAlbumList({ albums }: { albums: LocalAlbum[] }) {
  const { t } = useTranslation();
  const mixes = useMixStore((state) => state.mixes);
  const save = useMixStore((state) => state.save);

  const saveAsPlaylist = (album: LocalAlbum) => {
    const exists = mixes.some(
      (mix) =>
        mix.name === album.title &&
        mix.tracks.length === album.tracks.length &&
        mix.tracks.every((track, i) => track.id === album.tracks[i].id),
    );
    if (exists) return showToast(t("library.local.album_exists"), "info");
    save(album.title, album.tracks);
    showToast(t("library.local.album_saved"), "checkmark", {
      description: album.title,
    });
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
            onClick={() => saveAsPlaylist(album)}
            className={`${HERO_BUTTON_CLASS} px-[16px]`}
          >
            {t("library.local.album_save")}
          </Button>
        </div>
      ))}
    </div>
  );
}
