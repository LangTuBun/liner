import { api } from "@/shared/api";
import { toClientTrack } from "@/shared/api/track";
import { isLocalTrackId } from "@/shared/media/local";
import type { Track } from "@/shared/types";
import { useMixStore } from "@/features/mix/store/mixStore";
import { useVibeStore, vibesFor } from "@/features/mix/store/vibeStore";
import { playerEngine } from "@/features/player/engine/playerEngine";
import { findYoutubeStandIn } from "@/features/player/engine/youtubeStandIn";
import { readPlays } from "@/features/taste/lib/playLog";
import { correlateQueue } from "./correlateQueue";

/**
 * Starts `seed` immediately with an on-device correlated queue (vibes + mixes +
 * listening history), then refines the upcoming queue in the background with
 * YouTube Music's RDAMVM co-listening graph and any newly measured audio vibes.
 */
export function playCorrelatedLocalTrack(
  seed: Track,
  pool: Track[],
  context: string,
): void {
  const mixSources = useMixStore
    .getState()
    .mixes.map((mix) => ({ id: `mix:${mix.id}`, tracks: mix.tracks }));

  const buildOrder = (related?: Track[]) =>
    correlateQueue(seed, pool, {
      vibes: vibesFor(pool),
      plays: readPlays(),
      sources: mixSources,
      related,
    });

  const initialQueue = buildOrder();
  void playerEngine.playTrack(seed, initialQueue, context);

  if (pool.length <= 2) return;

  let latestRelated: Track[] | undefined;
  const applyRefinement = () => {
    playerEngine.replaceUpcomingQueue(seed.id, buildOrder(latestRelated));
  };

  // Measure acoustic vibes in the background for any local files not yet cached
  const unanalyzedCount = pool.filter(
    (t) =>
      isLocalTrackId(t.id) &&
      useVibeStore.getState().vibes[t.id.slice("local:".length)] === undefined,
  ).length;
  if (unanalyzedCount > 0) {
    void useVibeStore
      .getState()
      .analyze(pool)
      .then(() => applyRefinement())
      .catch(() => undefined);
  }

  // Fetch RDAMVM co-listening neighborhood for the seed track when online
  void (async () => {
    try {
      const standInId = isLocalTrackId(seed.id)
        ? await findYoutubeStandIn(seed)
        : seed.id;
      if (!standInId) return;
      const radio = await api.getRadio(standInId, { k: 25 });
      const related = radio.items.map(toClientTrack);
      if (related.length === 0) return;
      latestRelated = related;
      applyRefinement();
    } catch {
      // Offline or catalog lookup failed: the on-device correlated queue stays active
    }
  })();
}
