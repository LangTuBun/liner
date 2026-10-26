import type { HiResVerdict } from "./query";

export type LosslessJobState =
  | "starting"
  | "searching"
  | "downloading"
  | "importing"
  | "done"
  | "failed"
  | "cancelled"
  | "skipped";

export interface LosslessJob {
  id: string;
  batchId: string;
  batchName: string;
  title: string;
  artist: string;
  query: string;
  state: LosslessJobState;
  progress: number;
  error: string;
  preferHiRes: boolean;
  peerFile?: string;
  sampleRate?: number;
  bitDepth?: number;
  codec?: string;
  localId?: string;
  coverSize?: string;
  hiRes?: HiResVerdict | null;
  createdAt: number;
  updatedAt: number;
}

export interface LosslessStatus {
  install: {
    installed: boolean;
    supported: boolean;
    version: string;
    status: "idle" | "downloading" | "done" | "error";
    percent: number;
    error: string;
  };
  secureStorage: boolean;
  configured: boolean;
  username: string;
  daemon: "running" | "starting" | "stopped";
  soulseek: string | null;
  error: string;
  mock: boolean;
}

export interface LosslessSnapshot {
  status: LosslessStatus;
  jobs: LosslessJob[];
}

export interface LosslessDownloadRequest {
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  thumbnail?: string;
  // youtube catalog rows, whose channel names and video lengths may not match the release
  fromYoutube?: boolean;
}

export interface LosslessBatchSummary {
  batchId: string;
  submitted: number;
  skipped: number;
}
