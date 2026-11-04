import { initTelemetry } from "@/shared/telemetry";
import { initBackgroundStorageAnalytics } from "@/shared/utils/cacheManager";
import { initClientVisitorSession } from "@/shared/youtube";
import { initBundleStampLog } from "@/shared/utils/bundleStampLog";
import { initSavedTracks } from "@/features/library/saved";
import { initOfflineMode } from "@/features/connectivity/engine/offlineController";
import { initLocalLoudness } from "@/features/library/local/lib/measureLocalLoudness";
import { useLocalLibraryStore } from "@/features/library/local/store/localLibraryStore";
import { playerRuntime } from "@/features/player/engine/playerRuntime";

export function initMainWindowServices() {
  initTelemetry();
  initBackgroundStorageAnalytics();
  initClientVisitorSession();
  initBundleStampLog();
  initOfflineMode();
  initSavedTracks();
  initLocalLoudness();
  void useLocalLibraryStore.getState().load();
  useLocalLibraryStore.subscribe((state, previous) => {
    if (state.records !== previous.records) playerRuntime?.refreshVolumeMatch();
  });
}
