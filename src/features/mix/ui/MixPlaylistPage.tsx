import { useCallback, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CloseLine, DeleteLine, MusicLine, PlayFill } from "@mingcute/react";
import { LuShuffle } from "react-icons/lu";
import { useTranslation } from "@/languages";
import { cn } from "@/shared/lib";
import {
  EntityHero,
  HERO_BUTTON_CLASS,
  HERO_CHIP_CLASS,
  HERO_GLASS_BUTTON_CLASS,
  HERO_SUBTITLE_CLASS,
  HERO_TITLE_CLASS,
} from "@/shared/ui";
import Button from "@/shared/ui/Button";
import { useClassicSurfaces } from "@/features/settings/store/customizationStore";
import { SongCardWithMenu, playerEngine } from "@/features/player";
import { usePlayerStore } from "@/features/player/store/playerStore";
import { useMixStore } from "../store/mixStore";
import MixCover from "./MixCover";
import { NameField } from "./MixParts";

function formatLength(tracks: { durationMs: number }[]): string {
  const minutes = Math.round(
    tracks.reduce((sum, track) => sum + track.durationMs, 0) / 60000,
  );
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} h ${minutes % 60} min`
    : `${minutes} min`;
}

function clock(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// a saved smart mix, opened from the library like a playlist
export default function MixPlaylistPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const id = params.get("id");
  const mix = useMixStore((state) => state.mixes.find((m) => m.id === id));
  const rename = useMixStore((state) => state.rename);
  const removeMix = useMixStore((state) => state.remove);
  const removeTrack = useMixStore((state) => state.removeTrack);
  const classicSurfaces = useClassicSurfaces();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const play = useCallback(
    (startAt = 0) => {
      if (!mix || mix.tracks.length === 0) return;
      usePlayerStore.getState().setShuffle(false);
      playerEngine.clearQueue();
      void playerEngine.playTrack(
        mix.tracks[startAt],
        mix.tracks,
        mix.name,
        undefined,
        startAt,
      );
    },
    [mix],
  );

  const shuffle = useCallback(() => {
    if (!mix || mix.tracks.length === 0) return;
    playerEngine.clearQueue();
    void playerEngine.playShuffled(mix.tracks, mix.name);
  }, [mix]);

  if (!mix) {
    return (
      <div className="flex h-full w-full items-center justify-center text-[14px] text-text-secondary">
        {t("mix.not_found")}
      </div>
    );
  }

  const empty = mix.tracks.length === 0;

  return (
    <div className="relative h-full w-full overflow-hidden bg-transparent">
      <div
        ref={scrollRef}
        data-no-window-drag
        className="relative z-10 box-border flex h-full w-full min-h-0 flex-col overflow-x-hidden overflow-y-auto overscroll-contain pt-(--page-inset-top) pb-(--page-inset-bottom)"
      >
        <div className="shrink-0 pl-[16px] pr-[12px] pt-[8px]">
          <EntityHero
            cover={
              <MixCover tracks={mix.tracks} className="absolute inset-0" />
            }
            title={
              <NameField
                value={mix.name}
                onCommit={(name) => rename(mix.id, name)}
                className={cn(
                  HERO_TITLE_CLASS,
                  "m-0 w-full min-w-0 rounded-[8px] border-0 bg-transparent px-0 outline-none hover:bg-black/[0.05] focus:bg-black/[0.07] dark:hover:bg-white/[0.07] dark:focus:bg-white/[0.1]",
                )}
              />
            }
            subtitle={<p className={HERO_SUBTITLE_CLASS}>{t("mix.title")}</p>}
            meta={
              <div className={HERO_CHIP_CLASS}>
                <MusicLine size={13} className="shrink-0 text-text-secondary" />
                <span>{t("common.songs", { count: mix.tracks.length })}</span>
                {!empty && (
                  <>
                    <span
                      className="h-[3px] w-[3px] shrink-0 rounded-full bg-text-secondary/50"
                      aria-hidden
                    />
                    <span>{formatLength(mix.tracks)}</span>
                  </>
                )}
              </div>
            }
            actions={
              <>
                <Button
                  variant="primary"
                  onClick={() => play()}
                  disabled={empty}
                  className={`${HERO_BUTTON_CLASS} px-[22px]`}
                >
                  <PlayFill size={16} />
                  <span>{t("common.play_all")}</span>
                </Button>
                <Button
                  variant="secondary"
                  onClick={shuffle}
                  disabled={empty}
                  className={`${HERO_BUTTON_CLASS} ${HERO_GLASS_BUTTON_CLASS} !w-[52px] !p-0 text-text-primary`}
                  title={t("common.shuffle")}
                >
                  <LuShuffle size={18} />
                </Button>
              </>
            }
            trailingActions={
              <Button
                variant="secondary"
                onClick={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  removeMix(mix.id);
                  navigate("/library");
                }}
                onBlur={() => setConfirmDelete(false)}
                className={`${HERO_BUTTON_CLASS} ${HERO_GLASS_BUTTON_CLASS} px-[22px]`}
              >
                <DeleteLine size={16} />
                <span>
                  {confirmDelete ? t("mix.delete_confirm") : t("mix.delete")}
                </span>
              </Button>
            }
          />
        </div>

        <div
          className={cn(
            "mx-[4px] mt-[20px] shrink-0 grow overflow-hidden rounded-t-[14px] bg-black/[0.03] px-[8px] pt-[8px] dark:bg-white/[0.04]",
            !classicSurfaces && "backdrop-blur-xl",
          )}
          style={{
            marginBottom: "calc(var(--page-inset-bottom) * -1)",
            paddingBottom: "calc(var(--page-inset-bottom) + 16px)",
          }}
        >
          {empty ? (
            <p className="m-0 p-[24px] text-center text-[14px] text-text-secondary">
              {t("mix.empty_mix")}
            </p>
          ) : (
            mix.tracks.map((track, index) => (
              <SongCardWithMenu
                key={track.id}
                id={track.id}
                title={track.title}
                artists={track.artists}
                artistList={track.artistList as never}
                coverUrl={track.coverUrl}
                duration={clock(track.durationMs)}
                durationMs={track.durationMs}
                onPlay={() => play(index)}
                trailingAction={
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeTrack(mix.id, track.id);
                    }}
                    aria-label={t("mix.remove_song")}
                    title={t("mix.remove_song")}
                    className="flex cursor-pointer items-center border-0 bg-transparent p-[2px] text-text-tertiary hover:text-text-primary"
                  >
                    <CloseLine size={18} />
                  </button>
                }
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
