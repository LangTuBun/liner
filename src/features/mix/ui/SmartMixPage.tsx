import { useCallback, useMemo, useRef, useState } from "react";
import { CheckLine, DeleteLine, Magic1Line, PlayFill } from "@mingcute/react";
import { useTranslation } from "@/languages";
import { cn } from "@/shared/lib";
import {
  HERO_BUTTON_CLASS,
  HERO_GLASS_BUTTON_CLASS,
  HERO_GLASS_CLASS,
  useToast,
} from "@/shared/ui";
import Button from "@/shared/ui/Button";
import type { Track } from "@/shared/types";
import {
  fetchPlaylistTracks,
  usePlaylistsList,
} from "@/features/library/hooks";
import { useExternalItems } from "@/features/library/hooks/useExternalItems";
import { fetchCollectionTracks } from "@/features/collection/hooks/useCollection";
import { useLocalTracks } from "@/features/library/local/hooks/useLocalTracks";
import { playerEngine } from "@/features/player/engine/playerEngine";
import { usePlayerStore } from "@/features/player/store/playerStore";
import {
  buildSmartMix,
  type MixMode,
  type MixResult,
  type MixSource,
} from "../lib/smartMix";
import { useMixStore } from "../store/mixStore";
import { useVibeStore, vibesFor } from "../store/vibeStore";
import { MixTrackList, NameField } from "./MixParts";

const DOWNLOADED = "downloaded";
// source ids: downloaded, pl: your playlists, sp: saved playlists, al: saved albums
const MINE = "pl:";
const SAVED_PLAYLIST = "sp:";
const ALBUM = "al:";
const font = { fontFamily: "var(--font-inter), sans-serif" } as const;

function minutes(tracks: Track[]): number {
  return Math.round(tracks.reduce((sum, t) => sum + t.durationMs, 0) / 60000);
}

function playInOrder(tracks: Track[], context: string) {
  if (tracks.length === 0) return;
  usePlayerStore.getState().setShuffle(false);
  playerEngine.clearQueue();
  void playerEngine.playTrack(tracks[0], tracks, context);
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-[32px] cursor-pointer items-center gap-[6px] rounded-[9px] border-0 px-[12px] text-[13px] text-text-primary transition-colors",
        HERO_GLASS_CLASS,
        active
          ? "!bg-black/[0.14] dark:!bg-white/[0.24]"
          : "opacity-70 hover:opacity-100",
      )}
      style={font}
    >
      {active && <CheckLine size={14} />}
      {children}
    </button>
  );
}

export default function SmartMixPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { tracks: downloaded } = useLocalTracks();
  const { data: playlists } = usePlaylistsList();
  const { data: savedPlaylists } = useExternalItems("playlist");
  const { data: savedAlbums } = useExternalItems("album");
  const savedMixes = useMixStore((state) => state.mixes);
  const saveMix = useMixStore((state) => state.save);
  const removeMix = useMixStore((state) => state.remove);
  const renameMix = useMixStore((state) => state.rename);

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set([DOWNLOADED]),
  );
  const [mode, setMode] = useState<MixMode>("flow");
  const [result, setResult] = useState<MixResult | null>(null);
  const [building, setBuilding] = useState(false);
  const [failed, setFailed] = useState(false);
  const [listening, setListening] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // what you changed in a result before keeping it
  const [names, setNames] = useState<Record<number, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());

  const flip = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  };

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const playlistList = playlists.playlists;
  const sourceCount = useMemo(() => {
    const sizes = new Map<string, number>([[DOWNLOADED, downloaded.length]]);
    for (const p of playlistList) sizes.set(MINE + p.id, p.trackCount);
    for (const p of savedPlaylists)
      sizes.set(SAVED_PLAYLIST + p.id, p.trackCount ?? 0);
    for (const a of savedAlbums) sizes.set(ALBUM + a.id, a.trackCount ?? 0);
    return [...selected].reduce((sum, id) => sum + (sizes.get(id) ?? 0), 0);
  }, [selected, downloaded.length, playlistList, savedPlaylists, savedAlbums]);

  const build = useCallback(async () => {
    setBuilding(true);
    setFailed(false);
    try {
      const sources: MixSource[] = [];
      for (const id of selected) {
        if (id === DOWNLOADED) sources.push({ id, tracks: downloaded });
        else if (id.startsWith(MINE))
          sources.push({
            id,
            tracks: await fetchPlaylistTracks(id.slice(MINE.length)),
          });
        else if (id.startsWith(SAVED_PLAYLIST))
          sources.push({
            id,
            tracks: await fetchCollectionTracks(
              "playlist",
              id.slice(SAVED_PLAYLIST.length),
            ),
          });
        else
          sources.push({
            id,
            tracks: await fetchCollectionTracks(
              "album",
              id.slice(ALBUM.length),
            ),
          });
      }
      if (selected.has(DOWNLOADED)) {
        await useVibeStore
          .getState()
          .analyze(downloaded, (done, total) =>
            setListening(total > 0 && done < total ? { done, total } : null),
          );
      }
      setListening(null);
      const vibes = vibesFor(sources.flatMap((source) => source.tracks));
      setResult(buildSmartMix(sources, { mode, vibes }));
      setNames({});
      setRemoved(new Set());
      setOpen(new Set());
    } catch {
      setFailed(true);
    } finally {
      setBuilding(false);
    }
  }, [selected, downloaded, mode]);

  const save = useCallback(
    (name: string, tracks: Track[]) => {
      saveMix(name, tracks);
      toast(t("mix.saved"), "checkmark", { description: name });
    },
    [saveMix, toast, t],
  );

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div
        ref={scrollRef}
        data-no-window-drag
        className="h-full w-full overflow-y-auto bg-transparent px-[12px] pb-(--page-inset-bottom)"
        style={font}
      >
        <div className="pt-[36px] pb-[6px]">
          <h1 className="m-0 text-[26px] leading-tight font-bold tracking-tight text-text-primary">
            {t("mix.title")}
          </h1>
          <p className="m-0 mt-[6px] max-w-[560px] text-[14px] text-text-secondary">
            {t("mix.subtitle")}
          </p>
        </div>

        <h2 className="m-0 mt-[20px] mb-[8px] text-[13px] font-semibold text-text-tertiary uppercase">
          {t("mix.sources")}
        </h2>
        <div className="flex flex-wrap gap-[8px]">
          {downloaded.length > 0 && (
            <Chip
              active={selected.has(DOWNLOADED)}
              onClick={() => toggle(DOWNLOADED)}
            >
              {t("mix.downloaded", { count: downloaded.length })}
            </Chip>
          )}
          {playlistList.map((playlist) => (
            <Chip
              key={playlist.id}
              active={selected.has(MINE + playlist.id)}
              onClick={() => toggle(MINE + playlist.id)}
            >
              {playlist.title} · {playlist.trackCount}
            </Chip>
          ))}
        </div>
        {[
          {
            key: "group_saved_playlists",
            prefix: SAVED_PLAYLIST,
            list: savedPlaylists,
          },
          { key: "group_albums", prefix: ALBUM, list: savedAlbums },
        ].map(
          (group) =>
            group.list.length > 0 && (
              <div key={group.key}>
                <h2 className="m-0 mt-[16px] mb-[8px] text-[13px] font-semibold text-text-tertiary uppercase">
                  {t(`mix.${group.key}`)}
                </h2>
                <div className="flex max-h-[140px] flex-wrap gap-[8px] overflow-y-auto">
                  {group.list.map((item) => (
                    <Chip
                      key={item.id}
                      active={selected.has(group.prefix + item.id)}
                      onClick={() => toggle(group.prefix + item.id)}
                    >
                      {item.title}
                      {item.trackCount ? ` · ${item.trackCount}` : ""}
                    </Chip>
                  ))}
                </div>
              </div>
            ),
        )}

        <div className="mt-[16px] flex flex-wrap items-center gap-[8px]">
          {(["flow", "variety"] as const).map((value) => (
            <Chip
              key={value}
              active={mode === value}
              onClick={() => setMode(value)}
            >
              {t(`mix.mode_${value}`)}
            </Chip>
          ))}
          <Button
            variant="primary"
            disabled={building || selected.size === 0}
            onClick={() => void build()}
            className={`${HERO_BUTTON_CLASS} px-[16px]`}
          >
            <Magic1Line size={16} />
            <span>
              {listening
                ? t("mix.listening", listening)
                : result
                  ? t("mix.build_again")
                  : t("mix.build")}
              {!listening && sourceCount > 0 ? ` · ${sourceCount}` : ""}
            </span>
          </Button>
        </div>
        <p className="m-0 mt-[8px] text-[13px] text-text-tertiary">
          {t(`mix.mode_${mode}_hint`)}
        </p>
        {failed && (
          <p className="m-0 mt-[8px] text-[13px] text-accent-primary">
            {t("mix.failed")}
          </p>
        )}

        {result && result.combined.length > 0 && (
          <section className="mt-[24px]">
            <div className="flex flex-wrap items-center gap-[8px]">
              <h2 className="m-0 mr-auto text-[18px] font-semibold text-text-primary">
                {t("mix.result", {
                  songs: result.combined.length,
                  mixes: result.clusters.length,
                })}
                {result.duplicatesRemoved > 0 && (
                  <span className="ml-[8px] text-[13px] font-normal text-text-tertiary">
                    {t("mix.duplicates", { count: result.duplicatesRemoved })}
                  </span>
                )}
              </h2>
              <Button
                variant="primary"
                onClick={() => playInOrder(result.combined, t("mix.title"))}
                className={`${HERO_BUTTON_CLASS} px-[16px]`}
              >
                <PlayFill size={16} />
                <span>{t("mix.play_all")}</span>
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  for (const group of result.clusters) {
                    const kept = group.tracks.filter((x) => !removed.has(x.id));
                    if (kept.length > 0)
                      saveMix(
                        names[group.id] ||
                          group.label ||
                          `${t("mix.title")} ${group.id + 1}`,
                        kept,
                      );
                  }
                  toast(t("mix.saved_all"), "checkmark", {
                    description: String(result.clusters.length),
                  });
                }}
                className={`${HERO_BUTTON_CLASS} ${HERO_GLASS_BUTTON_CLASS} px-[16px]`}
              >
                {t("mix.save_all")}
              </Button>
            </div>

            <div className="mt-[12px] grid gap-[10px] [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
              {result.clusters.map((group) => {
                const name =
                  names[group.id] ||
                  group.label ||
                  `${t("mix.title")} ${group.id + 1}`;
                const kept = group.tracks.filter((x) => !removed.has(x.id));
                const key = `c${group.id}`;
                const expanded = open.has(key);
                return (
                  <div
                    key={group.id}
                    className="flex flex-col gap-[8px] rounded-[14px] bg-black/[0.03] p-[14px] backdrop-blur-xl dark:bg-white/[0.04]"
                  >
                    <NameField
                      value={name}
                      onCommit={(next) =>
                        setNames((prev) => ({ ...prev, [group.id]: next }))
                      }
                    />
                    <div className="px-[4px] text-[13px] text-text-tertiary">
                      {t("mix.cluster_meta", {
                        songs: kept.length,
                        minutes: minutes(kept),
                      })}
                    </div>
                    {expanded ? (
                      <MixTrackList
                        tracks={kept}
                        onRemove={(id) =>
                          setRemoved((prev) => new Set(prev).add(id))
                        }
                      />
                    ) : (
                      <div className="min-h-[54px] px-[4px] text-[13px] leading-[1.4] text-text-secondary">
                        {kept.slice(0, 3).map((track) => (
                          <div key={track.id} className="truncate">
                            {track.title}
                          </div>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setOpen((prev) => flip(prev, key))}
                      className="cursor-pointer self-start border-0 bg-transparent px-[4px] text-[13px] text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
                    >
                      {expanded
                        ? t("mix.hide_songs")
                        : t("mix.show_songs", { count: kept.length })}
                    </button>
                    <div className="flex gap-[8px]">
                      <Button
                        variant="primary"
                        disabled={kept.length === 0}
                        onClick={() => playInOrder(kept, name)}
                        className={`${HERO_BUTTON_CLASS} px-[14px]`}
                      >
                        <PlayFill size={15} />
                        <span>{t("mix.play")}</span>
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={kept.length === 0}
                        onClick={() => save(name, kept)}
                        className={`${HERO_BUTTON_CLASS} ${HERO_GLASS_BUTTON_CLASS} px-[14px]`}
                      >
                        {t("mix.save")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {result && result.combined.length === 0 && (
          <p className="mt-[20px] text-[14px] text-text-secondary">
            {t("mix.empty")}
          </p>
        )}

        {savedMixes.length > 0 && (
          <section className="mt-[28px] pb-[20px]">
            <h2 className="m-0 mb-[8px] text-[13px] font-semibold text-text-tertiary uppercase">
              {t("mix.saved_mixes")}
            </h2>
            <div className="flex flex-col gap-[6px]">
              {savedMixes.map((mix) => {
                const key = `m${mix.id}`;
                const expanded = open.has(key);
                return (
                  <div
                    key={mix.id}
                    className="flex flex-col gap-[8px] rounded-[10px] bg-black/[0.03] px-[12px] py-[8px] dark:bg-white/[0.04]"
                  >
                    <div className="flex items-center gap-[10px]">
                      <button
                        type="button"
                        onClick={() => playInOrder(mix.tracks, mix.name)}
                        aria-label={t("mix.play")}
                        className="flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-accent-primary text-white"
                      >
                        <PlayFill size={15} />
                      </button>
                      <div className="min-w-0 flex-1">
                        <NameField
                          value={mix.name}
                          onCommit={(next) => renameMix(mix.id, next)}
                          className="w-full min-w-0 rounded-[6px] border-0 bg-transparent px-[4px] py-[1px] text-[14px] font-medium text-text-primary outline-none hover:bg-black/[0.05] focus:bg-black/[0.07] dark:hover:bg-white/[0.07] dark:focus:bg-white/[0.1]"
                        />
                        <button
                          type="button"
                          onClick={() => setOpen((prev) => flip(prev, key))}
                          className="cursor-pointer border-0 bg-transparent px-[4px] text-[12.5px] text-text-tertiary hover:text-text-primary"
                        >
                          {t("mix.cluster_meta", {
                            songs: mix.tracks.length,
                            minutes: minutes(mix.tracks),
                          })}
                          {" · "}
                          {expanded
                            ? t("mix.hide_songs")
                            : t("mix.show_songs", { count: mix.tracks.length })}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeMix(mix.id)}
                        aria-label={t("mix.delete")}
                        className="flex cursor-pointer items-center border-0 bg-transparent p-[4px] text-text-tertiary hover:text-text-primary"
                      >
                        <DeleteLine size={18} />
                      </button>
                    </div>
                    {expanded && <MixTrackList tracks={mix.tracks} />}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
