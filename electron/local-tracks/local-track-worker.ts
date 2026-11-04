import { parentPort, workerData } from "node:worker_threads";
import { runLocalTrackTask, type LocalTrackTask } from "./workerTask.js";

runLocalTrackTask(workerData as LocalTrackTask)
  .then(
    (value) => parentPort!.postMessage({ value }),
    (error: unknown) =>
      parentPort!.postMessage({
        error: error instanceof Error ? error.message : String(error),
      }),
  )
  .finally(() => parentPort!.close());
