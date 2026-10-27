import { create } from "zustand";
import { persist } from "zustand/middleware";
import { showToast } from "@/shared/ui";
import { createTranslatorSync, getStoredLocale } from "@/languages";
import { useLocalLibraryStore } from "@/features/library/local/store/localLibraryStore";
import type {
  LosslessDownloadRequest,
  LosslessJob,
  LosslessSnapshot,
} from "../../../../electron/lossless/types";
import { checkHiRes } from "../lib/hiresCheck";
import { saveFromYoutube } from "../lib/youtubeFallback";
import { recordProgress, type ProgressLog } from "../lib/stall";

export type { LosslessDownloadRequest, LosslessJob, LosslessSnapshot };

const FINISHED = new Set<LosslessJob["state"]>([
  "done",
  "failed",
  "cancelled",
  "skipped",
]);
const HIRES_MIN_RATE = 88_200;

export function isFinishedJob(job: LosslessJob): boolean {
  return FINISHED.has(job.state);
}

// ipc errors arrive as "Error invoking remote method 'x': Error: message"
export function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

// what became of a song soulseek could not find, for the download list
export interface FallbackStatus {
  state: "queued" | "saving" | "saved" | "failed";
  // the quality it was saved at, or why it failed
  detail?: string;
  // why soulseek was given up on
  reason?: "missing" | "stalled";
}

interface LosslessState {
  snapshot: LosslessSnapshot | null;
  dialogOpen: boolean;
  preferHiRes: boolean;
  youtubeFallback: boolean;
  fallback: Record<string, FallbackStatus>;
  setDialogOpen: (open: boolean) => void;
  setPreferHiRes: (value: boolean) => void;
  setYoutubeFallback: (value: boolean) => void;
  init: () => () => void;
  refresh: () => Promise<void>;
  install: () => Promise<void>;
  setAccount: (username: string, password: string) => Promise<void>;
  clearAccount: () => Promise<void>;
  // true when the job was handed to the downloader; opens the dialog when setup is missing
  download: (track: LosslessDownloadRequest) => Promise<boolean>;
  downloadBatch: (
    tracks: LosslessDownloadRequest[],
    name: string,
  ) => Promise<boolean>;
  cancel: (id: string) => Promise<void>;
  clearFinished: () => Promise<void>;
}

const t = (key: string, vars?: Record<string, string | number>) =>
  createTranslatorSync(getStoredLocale())(key, vars);

let previousJobs = new Map<string, LosslessJob>();
const announcedBatches = new Set<string>();
const hiResQueue: LosslessJob[] = [];
const hiResSeen = new Set<string>();
let hiResRunning = false;

async function drainHiResQueue() {
  if (hiResRunning) return;
  hiResRunning = true;
  try {
    while (hiResQueue.length) {
      const job = hiResQueue.shift()!;
      let verdict = "unknown";
      try {
        verdict = await checkHiRes(job.localId!, job.sampleRate!);
      } catch {}
      await window.linerElectron?.losslessSetHiRes(job.localId!, verdict);
      if (verdict === "upsampled")
        showToast(t("lossless.toast.upsampled"), "info", {
          description: job.title,
        });
    }
  } finally {
    hiResRunning = false;
  }
}

// how long soulseek gets to find a copy before the song is saved from YouTube
export const SEARCH_PATIENCE_MS = 90_000;
const progressLog = new Map<string, ProgressLog>();
const PATIENCE_CHECK_MS = 5_000;
const requestByText = new Map<string, LosslessDownloadRequest>();
const searchingSince = new Map<string, number>();
const fallbackJobs = new Set<string>();
const fallbackQueue: { job: LosslessJob; request: LosslessDownloadRequest }[] =
  [];
let fallbackRunning = false;
let batchSaved = 0;
let batchFailed = 0;

const textKey = (title: string, artist: string) => `${title}\u0000${artist}`;

function remember(request: LosslessDownloadRequest) {
  requestByText.set(textKey(request.title, request.artist), request);
}

function isStalled(job: LosslessJob, now: number): boolean {
  let log = progressLog.get(job.id);
  if (!log) {
    log = { since: now, samples: [] };
    progressLog.set(job.id, log);
  }
  return recordProgress(log, job.progress, now, PATIENCE_CHECK_MS);
}

function setFallback(id: string, status: FallbackStatus) {
  useLosslessStore.setState((state) => ({
    fallback: { ...state.fallback, [id]: { ...state.fallback[id], ...status } },
  }));
}

// when this job started searching, for the countdown in the download list
export function searchingSinceOf(jobId: string): number | undefined {
  return searchingSince.get(jobId);
}

// true when this job would be saved from YouTube if soulseek comes up empty
export function fallbackAvailable(job: LosslessJob): boolean {
  return (
    useLosslessStore.getState().youtubeFallback &&
    Boolean(requestByText.get(textKey(job.title, job.artist))?.trackId)
  );
}

// true when the song will be saved from YouTube instead
function startFallback(
  job: LosslessJob,
  reason: FallbackStatus["reason"] = "missing",
): boolean {
  if (!useLosslessStore.getState().youtubeFallback) return false;
  if (fallbackJobs.has(job.id)) return true;
  const request = requestByText.get(textKey(job.title, job.artist));
  if (!request?.trackId) return false;
  fallbackJobs.add(job.id);
  setFallback(job.id, { state: "queued", reason });
  fallbackQueue.push({ job, request });
  if (!job.batchId)
    showToast(t("lossless.toast.youtube_saving"), "loader", {
      id: `lossless-${job.id}`,
      description: job.title,
    });
  void drainFallbackQueue();
  return true;
}

async function drainFallbackQueue() {
  if (fallbackRunning) return;
  fallbackRunning = true;
  try {
    while (fallbackQueue.length) {
      const { job, request } = fallbackQueue.shift()!;
      setFallback(job.id, { state: "saving" });
      try {
        const saved = await saveFromYoutube(request);
        setFallback(job.id, { state: "saved", detail: saved.quality });
        if (job.batchId) batchSaved += 1;
        else
          showToast(t("lossless.toast.youtube_saved"), "checkmark", {
            id: `lossless-${job.id}`,
            description: job.title,
          });
      } catch (error) {
        setFallback(job.id, {
          state: "failed",
          detail: ipcErrorMessage(error),
        });
        if (job.batchId) batchFailed += 1;
        else
          showToast(t("lossless.toast.youtube_failed"), "error", {
            id: `lossless-${job.id}`,
            description: `${job.title} · ${ipcErrorMessage(error)}`,
          });
      }
      void useLocalLibraryStore.getState().load();
    }
  } finally {
    fallbackRunning = false;
  }
  if (batchSaved + batchFailed > 0) {
    showToast(
      t("lossless.toast.youtube_batch_saved", { count: batchSaved }),
      batchSaved ? "checkmark" : "error",
      {
        id: "lossless-youtube-batch",
        description: batchFailed
          ? t("lossless.toast.youtube_batch_missing", { count: batchFailed })
          : undefined,
      },
    );
    batchSaved = 0;
    batchFailed = 0;
  }
}

function react(jobs: LosslessJob[]) {
  const previous = previousJobs;
  previousJobs = new Map(jobs.map((job) => [job.id, job]));
  let added = false;
  for (const job of jobs) {
    const before = previous.get(job.id);
    const justFinished = before && !isFinishedJob(before) && isFinishedJob(job);
    if (job.state === "starting" || job.state === "searching") {
      if (!searchingSince.has(job.id)) searchingSince.set(job.id, Date.now());
    } else searchingSince.delete(job.id);
    if (justFinished && job.state === "failed") startFallback(job);
    // a song on its way from YouTube shows its own toasts, not the cancel or fail
    const quiet = fallbackJobs.has(job.id);
    if (justFinished && job.state === "done") added = true;
    if (justFinished && !job.batchId && !quiet) {
      const id = `lossless-${job.id}`;
      if (job.state === "done")
        showToast(t("lossless.toast.saved"), "checkmark", {
          id,
          description: job.title,
        });
      else if (job.state === "skipped")
        showToast(job.error, "info", { id, description: job.title });
      else
        showToast(
          job.state === "cancelled"
            ? t("lossless.toast.cancelled")
            : t("lossless.toast.failed"),
          job.state === "cancelled" ? "info" : "error",
          { id, description: `${job.title} · ${job.error}` },
        );
    }
    if (
      job.state === "done" &&
      job.localId &&
      job.hiRes === null &&
      (job.sampleRate ?? 0) >= HIRES_MIN_RATE &&
      !hiResSeen.has(job.localId)
    ) {
      hiResSeen.add(job.localId);
      hiResQueue.push(job);
    }
  }
  const batches = new Map<string, LosslessJob[]>();
  for (const job of jobs) {
    if (!job.batchId) continue;
    const list = batches.get(job.batchId) ?? [];
    list.push(job);
    batches.set(job.batchId, list);
  }
  for (const [batchId, list] of batches) {
    if (announcedBatches.has(batchId) || !list.every(isFinishedJob)) continue;
    const wasRunning = list.some((job) => {
      const before = previous.get(job.id);
      return before && !isFinishedJob(before);
    });
    announcedBatches.add(batchId);
    if (!wasRunning) continue;
    const done = list.filter((job) => job.state === "done").length;
    showToast(t("lossless.toast.batch_done", { count: done }), "checkmark", {
      id: `lossless-batch-${batchId}`,
      description: t("lossless.toast.batch_detail", {
        name: list[0].batchName || t("lossless.title"),
        missing: list.filter(
          (job) => job.state === "failed" && !fallbackJobs.has(job.id),
        ).length,
      }),
    });
  }
  if (added) void useLocalLibraryStore.getState().load();
  if (hiResQueue.length) void drainHiResQueue();
}

export const useLosslessStore = create<LosslessState>()(
  persist(
    (set, get) => {
      const apply = (snapshot: LosslessSnapshot) => {
        react(snapshot.jobs);
        set({ snapshot });
      };
      const bridge = () => window.linerElectron;
      const needsSetup = () => {
        const status = get().snapshot?.status;
        return !status || !status.install.installed || !status.configured;
      };

      return {
        snapshot: null,
        dialogOpen: false,
        preferHiRes: false,
        youtubeFallback: true,
        fallback: {},
        setDialogOpen: (dialogOpen) => set({ dialogOpen }),
        setPreferHiRes: (preferHiRes) => set({ preferHiRes }),
        setYoutubeFallback: (youtubeFallback) => set({ youtubeFallback }),

        init: () => {
          const api = bridge();
          if (!api?.onLosslessChanged) return () => undefined;
          void get().refresh();
          const unsubscribe = api.onLosslessChanged(apply);
          // a search that drags on gives way to the song's own stream
          const timer = setInterval(() => {
            const now = Date.now();
            for (const job of get().snapshot?.jobs ?? []) {
              if (job.state === "downloading") {
                if (isStalled(job, now) && startFallback(job, "stalled"))
                  void bridge()?.losslessCancel(job.id);
                continue;
              }
              progressLog.delete(job.id);
              const since = searchingSince.get(job.id);
              if (!since || now - since < SEARCH_PATIENCE_MS) continue;
              if (job.state !== "starting" && job.state !== "searching")
                continue;
              if (startFallback(job)) void bridge()?.losslessCancel(job.id);
            }
          }, PATIENCE_CHECK_MS);
          return () => {
            clearInterval(timer);
            unsubscribe();
          };
        },

        refresh: async () => {
          const api = bridge();
          if (!api?.losslessSnapshot) return;
          apply(await api.losslessSnapshot());
        },

        install: async () => {
          const api = bridge();
          if (api) apply(await api.losslessInstall());
        },

        setAccount: async (username, password) => {
          const api = bridge();
          if (api) apply(await api.losslessSetAccount(username, password));
        },

        clearAccount: async () => {
          const api = bridge();
          if (api) apply(await api.losslessClearAccount());
        },

        download: async (track) => {
          const api = bridge();
          if (!api) return false;
          if (!get().snapshot) await get().refresh();
          if (needsSetup()) {
            set({ dialogOpen: true });
            return false;
          }
          try {
            remember(track);
            const job = await api.losslessDownload(track, get().preferHiRes);
            if (job.state === "failed") {
              showToast(t("lossless.toast.failed"), "error", {
                description: job.error,
              });
              return false;
            }
            if (!isFinishedJob(job))
              showToast(t("lossless.toast.searching"), "loader", {
                id: `lossless-${job.id}`,
                description: track.title,
              });
            return true;
          } catch (error) {
            showToast(t("lossless.toast.failed"), "error", {
              description: ipcErrorMessage(error),
            });
            return false;
          }
        },

        downloadBatch: async (tracks, name) => {
          const api = bridge();
          if (!api || tracks.length === 0) return false;
          if (!get().snapshot) await get().refresh();
          if (needsSetup()) {
            set({ dialogOpen: true });
            return false;
          }
          try {
            tracks.forEach(remember);
            const summary = await api.losslessDownloadBatch(
              tracks,
              name,
              get().preferHiRes,
            );
            showToast(
              t("lossless.toast.batch_started", { count: summary.submitted }),
              summary.submitted ? "loader" : "info",
              {
                id: `lossless-batch-${summary.batchId}`,
                description: summary.skipped
                  ? t("lossless.toast.batch_skipped", {
                      name,
                      count: summary.skipped,
                    })
                  : name,
              },
            );
            return true;
          } catch (error) {
            showToast(t("lossless.toast.failed"), "error", {
              description: ipcErrorMessage(error),
            });
            return false;
          }
        },

        cancel: async (id) => {
          await bridge()?.losslessCancel(id);
        },

        clearFinished: async () => {
          await bridge()?.losslessClearFinished();
        },
      };
    },
    {
      name: "liner_lossless_v1",
      partialize: (state) => ({
        preferHiRes: state.preferHiRes,
        youtubeFallback: state.youtubeFallback,
      }),
    },
  ),
);
