import { availableParallelism } from "node:os";
import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { LocalTrackTask, PreparedLocalFile } from "./workerTask.js";
import type { LoudnessMeasurement } from "./loudness.js";

export class LocalTrackWorkerPool {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(
    // Cap simultaneous decoder heaps and disk writers even on large CPUs.
    readonly size = Math.max(1, Math.min(12, availableParallelism() - 2)),
    private readonly entry = new URL(
      "./local-track-worker.cjs",
      import.meta.url,
    ),
  ) {
    if (!Number.isInteger(size) || size < 1)
      throw new Error("Invalid pool size");
  }

  run(
    task: Extract<LocalTrackTask, { kind: "prepare" }>,
  ): Promise<PreparedLocalFile | null>;
  run(
    task: Extract<LocalTrackTask, { kind: "measure" }>,
  ): Promise<LoudnessMeasurement>;
  run(
    task: LocalTrackTask,
  ): Promise<PreparedLocalFile | LoudnessMeasurement | null>;
  async run(task: LocalTrackTask): Promise<unknown> {
    if (this.active >= this.size)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      // Electron can read inside asar; Node's worker module loader cannot.
      const source = await readFile(this.entry, "utf8");
      return await new Promise((resolve, reject) => {
        const worker = new Worker(source, { eval: true, workerData: task });
        let reply: { value?: unknown; error?: string } | undefined;
        let failure: Error | undefined;
        worker.once("message", (message) => {
          reply = message;
        });
        worker.once("error", (error) => {
          failure = error;
        });
        worker.once("exit", (code) => {
          if (failure) reject(failure);
          else if (code !== 0 || !reply)
            reject(new Error(`Local track worker exited (${code})`));
          else if (reply.error) reject(new Error(reply.error));
          else resolve(reply.value);
        });
      });
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export const localTrackWorkers = new LocalTrackWorkerPool();
