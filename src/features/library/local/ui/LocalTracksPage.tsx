import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { playerEngine } from "@/features/player";
import {
  TrackSearchEmpty,
  TrackSearchField,
  useTrackSearch,
} from "../../ui/TrackSearch";
import { TrackSortMenu, useTrackSort } from "../../ui/TrackSort";
import { useTranslation } from "@/languages";
import { HERO_GLASS_CLASS, ListPanel } from "@/shared/ui";
import Button from "@/shared/ui/Button";
import { useLocalImport } from "../hooks/useLocalImport";
import { useLocalTracks } from "../hooks/useLocalTracks";
import { groupLocalAlbums } from "../lib/albums";
import { playCorrelatedLocalTrack } from "../lib/playCorrelated";
import { useLocalLibraryStore } from "../store/localLibraryStore";
import LocalAlbumList from "./LocalAlbumList";
import LocalTrackList from "./LocalTrackList";
import LocalTracksEmpty from "./LocalTracksEmpty";
import LocalTracksHero from "./LocalTracksHero";
import RemoveAllLocalDialog from "./RemoveAllLocalDialog";
import TidyDuplicatesDialog from "./TidyDuplicatesDialog";

const PAGE_KEY = "local";

export default function LocalTracksPage() {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { tracks, isLoading } = useLocalTracks();
  const { chooseFiles, chooseFolder, importing } = useLocalImport();
  const [removeAllOpen, setRemoveAllOpen] = useState(false);
  const [view, setView] = useState<"songs" | "albums">("songs");
  const [tidyOpen, setTidyOpen] = useState(false);
  const records = useLocalLibraryStore((state) => state.records);
  const albums = useMemo(() => groupLocalAlbums(records), [records]);

  const sort = useTrackSort(tracks, PAGE_KEY);
  const search = useTrackSearch(sort.sorted, PAGE_KEY);
  const entries = useMemo(
    () =>
      search.matches ?? sort.sorted.map((track, index) => ({ track, index })),
    [search.matches, sort.sorted],
  );
  const context = t("library.local.title");

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [search.activeQuery, sort.option]);

  const playAll = useCallback(() => {
    if (!sort.sorted.length) return;
    playerEngine.clearQueue();
    playCorrelatedLocalTrack(sort.sorted[0], sort.sorted, context);
  }, [sort.sorted, context]);

  const shuffle = useCallback(() => {
    if (!sort.sorted.length) return;
    playerEngine.clearQueue();
    void playerEngine.playShuffled(sort.sorted, context);
  }, [sort.sorted, context]);

  const submitSearch = useCallback(() => {
    const first = search.matches?.[0];
    if (first) playCorrelatedLocalTrack(first.track, sort.sorted, context);
  }, [search.matches, sort.sorted, context]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-transparent">
      <div
        ref={scrollRef}
        data-no-window-drag
        className="relative z-10 box-border flex h-full w-full min-h-0 flex-col overflow-x-hidden overflow-y-auto overscroll-contain pt-(--page-inset-top) pb-(--page-inset-bottom)"
      >
        <div className="shrink-0 pl-[16px] pr-[12px] pt-[8px]">
          <LocalTracksHero
            tracks={tracks}
            importing={importing}
            onPlayAll={playAll}
            onShuffle={shuffle}
            onAddFiles={() => void chooseFiles()}
            onAddFolder={() => void chooseFolder()}
            onRemoveAll={() => setRemoveAllOpen(true)}
            search={
              <TrackSearchField
                search={search}
                totalCount={tracks.length}
                placeholder={t("track_search.placeholder_playlist")}
                onSubmit={submitSearch}
                className={HERO_GLASS_CLASS}
              />
            }
            sort={<TrackSortMenu sort={sort} disabled={tracks.length < 2} />}
          />
        </div>

        <ListPanel>
          {tracks.length > 0 && (
            <div className="flex gap-[6px] pb-[8px]">
              {(["songs", "albums"] as const).map((option) => (
                <Button
                  key={option}
                  variant={view === option ? "primary" : "secondary"}
                  onClick={() => setView(option)}
                  className="px-[14px]"
                >
                  {t(`library.local.view_${option}`)}
                </Button>
              ))}
              <Button
                variant="secondary"
                onClick={() => setTidyOpen(true)}
                className="ml-auto px-[14px]"
              >
                {t("library.local.tidy_button")}
              </Button>
            </div>
          )}
          {isLoading ? null : view === "albums" && tracks.length > 0 ? (
            <LocalAlbumList albums={albums} />
          ) : tracks.length === 0 ? (
            <LocalTracksEmpty
              importing={importing}
              onAddFiles={() => void chooseFiles()}
              onAddFolder={() => void chooseFolder()}
            />
          ) : search.matches && search.matches.length === 0 ? (
            <TrackSearchEmpty
              query={search.activeQuery}
              onClear={() => search.setQuery("")}
            />
          ) : (
            <LocalTrackList
              entries={entries}
              queue={sort.sorted}
              highlight={search.activeQuery || undefined}
              scrollRef={scrollRef}
            />
          )}
        </ListPanel>
      </div>
      <TidyDuplicatesDialog
        open={tidyOpen}
        onClose={() => setTidyOpen(false)}
      />
      <RemoveAllLocalDialog
        open={removeAllOpen}
        onClose={() => setRemoveAllOpen(false)}
      />
    </div>
  );
}
