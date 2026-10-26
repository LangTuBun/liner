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

interface LosslessState {
  snapshot: LosslessSnapshot | null;
  dialogOpen: boolean;
  preferHiRes: boolean;
  setDialogOpen: (open: boolean) => void;
  setPreferHiRes: (value: boolean) => void;
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

function react(jobs: LosslessJob[]) {
  const previous = previousJobs;
  previousJobs = new Map(jobs.map((job) => [job.id, job]));
  let added = false;
  for (const job of jobs) {
    const before = previous.get(job.id);
    const justFinished = before && !isFinishedJob(before) && isFinishedJob(job);
    if (justFinished && job.state === "done") added = true;
    if (justFinished && !job.batchId) {
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
        missing: list.filter((job) => job.state === "failed").length,
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
        setDialogOpen: (dialogOpen) => set({ dialogOpen }),
        setPreferHiRes: (preferHiRes) => set({ preferHiRes }),

        init: () => {
          const api = bridge();
          if (!api?.onLosslessChanged) return () => undefined;
          void get().refresh();
          return api.onLosslessChanged(apply);
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
      partialize: (state) => ({ preferHiRes: state.preferHiRes }),
    },
  ),
);
