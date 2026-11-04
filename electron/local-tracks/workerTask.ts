import fsp from "node:fs/promises";
import path from "node:path";
import {
  commitLocalFile,
  inspectLocalFile,
  type IncomingFile,
} from "./importer.js";
import { measureWav } from "./loudnessWav.js";
import type { LocalTrackRecord } from "./types.js";

export type LocalTrackTask =
  | { kind: "prepare"; source: string; root: string; known?: string[] }
  | { kind: "measure"; source: string };

export async function runLocalTrackTask(task: LocalTrackTask) {
  if (task.kind === "measure") return measureWav(task.source);
  const file = await inspectLocalFile(task.source, new Set(task.known));
  if (!file) return null;
  const prepared: PreparedLocalFile = { file, root: task.root };
  try {
    await fsp.mkdir(path.join(task.root, "audio"), { recursive: true });
    await fsp.mkdir(path.join(task.root, "covers"), { recursive: true });
    prepared.record = await commitLocalFile(file, task.root);
  } catch (error) {
    // A speculative conversion failure must not turn a duplicate or kept copy
    // into a failure when the coordinator decides it never needed the audio.
    prepared.error = error instanceof Error ? error.message : String(error);
  }
  return prepared;
}

export interface PreparedLocalFile {
  file: IncomingFile;
  root: string;
  record?: LocalTrackRecord;
  error?: string;
}
