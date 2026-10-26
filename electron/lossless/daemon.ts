import crypto from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { safeStorage } from "electron";
import {
  buildSockseekConf,
  buildSongJobRequest,
  cleanSoulseekQuery,
  isLosslessExtension,
  queryKey,
  type LosslessTrackInput,
} from "./query.js";
import type {
  LosslessBatchSummary,
  LosslessJob,
  LosslessStatus,
} from "./types.js";

export interface TrackRequest extends LosslessTrackInput {
  thumbnail?: string;
  preferHiRes?: boolean;
}

// job fields that stay in the main process
export interface InternalJob extends LosslessJob {
  key: string;
  ssJobId?: string;
  finished?: boolean;
  cleanArtist: string;
  cleanTitle: string;
  thumbnail: string;
}

export interface DaemonDeps {
  workDir: string;
  binaryPath: () => string | null;
  // test runs point sockseek at a folder of local files instead of the network
  mockFilesDir?: string;
  onDownloaded: (
    job: InternalJob,
    filePath: string,
  ) => Promise<Partial<LosslessJob>>;
  hasLibraryTrack: (key: string) => Promise<boolean>;
  onChange: () => void;
}

const FAILURE_MESSAGES: Record<string, string> = {
  NoSearchResults: "No lossless copy found on Soulseek",
  NoMatchingResults: "No lossless copy found on Soulseek",
  InvalidSearchString: "Track title is missing",
  AllDownloadsFailed: "Every peer failed to send the file",
  OutOfDownloadRetries: "Every peer failed to send the file",
  Cancelled: "Cancelled",
};
const START_TIMEOUT_MS = 25_000;
const POLL_MS = 1_000;
const MAX_JOBS = 500;

interface SockseekJobDetail {
  summary?: {
    lifecycleState?: string;
    terminalOutcome?: string;
    failureReason?: string;
    failureMessage?: string;
  };
  payload?: {
    progressPercent?: number;
    resolvedFilename?: string;
    resolvedSampleRate?: number;
    resolvedAttributes?: Array<{ type?: string; value?: unknown }>;
    transferState?: string;
    downloadSource?: string;
    downloadPath?: string;
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function newId(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export class LosslessDaemon {
  private proc: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  private error = "";
  private soulseek: string | null = null;
  private readonly jobs = new Map<string, InternalJob>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private importChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DaemonDeps) {}

  private get incomingDir() {
    return path.join(this.deps.workDir, "incoming");
  }

  private get confPath() {
    return path.join(this.deps.workDir, "sockseek.conf");
  }

  private get pidPath() {
    return path.join(this.deps.workDir, "daemon.pid");
  }

  private get authPath() {
    return path.join(this.deps.workDir, "soulseek-auth.enc");
  }

  // ---- account ----

  canStoreAuth(): boolean {
    return (
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" ||
        safeStorage.getSelectedStorageBackend() !== "basic_text")
    );
  }

  private loadAuth(): { username: string; password: string } | null {
    if (!this.canStoreAuth()) return null;
    try {
      const saved = JSON.parse(
        safeStorage.decryptString(fs.readFileSync(this.authPath)),
      );
      if (
        typeof saved?.username === "string" &&
        typeof saved?.password === "string"
      )
        return saved;
    } catch {}
    return null;
  }

  saveAuth(username: string, password: string): void {
    if (!this.canStoreAuth())
      throw new Error("Secure storage is not available on this system");
    buildSockseekConf({ username, password });
    fs.mkdirSync(this.deps.workDir, { recursive: true });
    const temp = `${this.authPath}.tmp`;
    fs.writeFileSync(
      temp,
      safeStorage.encryptString(JSON.stringify({ username, password })),
      { mode: 0o600 },
    );
    fs.renameSync(temp, this.authPath);
    this.stop();
  }

  clearAuth(): void {
    this.stop();
    fs.rmSync(this.authPath, { force: true });
  }

  // ---- daemon ----

  private async api<T>(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.port}${route}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok)
      throw new Error(
        data?.detail ||
          data?.title ||
          data?.error ||
          `sockseek HTTP ${res.status}`,
      );
    return data as T;
  }

  private async start(): Promise<void> {
    if (this.proc) return;
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async launch(): Promise<void> {
    const bin = this.deps.binaryPath();
    if (!bin) throw new Error("sockseek is not installed");
    const mock = this.deps.mockFilesDir;
    const auth = mock ? null : this.loadAuth();
    if (!mock && !auth) throw new Error("Add your Soulseek account first");
    this.killStale();
    fs.mkdirSync(this.incomingDir, { recursive: true });
    if (auth)
      fs.writeFileSync(this.confPath, buildSockseekConf(auth), { mode: 0o600 });
    this.port = await freePort();
    const args = [
      "daemon",
      "-c",
      auth ? this.confPath : "none",
      "-o",
      this.incomingDir,
      "--server-ip",
      "127.0.0.1",
      "--server-port",
      String(this.port),
    ];
    if (mock) args.push("--mock-files-dir", mock);
    const proc = spawn(bin, args, {
      cwd: this.deps.workDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-4000);
    };
    proc.stdout?.on("data", keep);
    proc.stderr?.on("data", keep);
    this.proc = proc;
    this.error = "";
    if (proc.pid) fs.writeFileSync(this.pidPath, String(proc.pid));
    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.soulseek = null;
      if (code) {
        this.error = `sockseek stopped (exit ${code})`;
        console.error(
          "[lossless] sockseek exited:",
          tail.split("\n").slice(-12).join("\n"),
        );
      }
      for (const job of this.jobs.values()) {
        if (!job.finished)
          this.finish(job, "failed", "sockseek stopped unexpectedly");
      }
      this.deps.onChange();
    });
    proc.on("error", (err) => {
      this.error = err.message;
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error(this.error || "sockseek failed to start");
      try {
        const status = await this.api<{ soulseekClient?: string }>(
          "GET",
          "/api/server/status",
        );
        this.soulseek = status?.soulseekClient ?? null;
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    this.stop();
    throw new Error("sockseek did not start in time");
  }

  stop(): void {
    const proc = this.proc;
    this.proc = null;
    this.soulseek = null;
    if (proc) {
      try {
        proc.kill();
      } catch {}
    }
    for (const job of this.jobs.values()) {
      if (!job.finished && job.state !== "importing")
        this.finish(job, "cancelled", "Downloader stopped");
    }
    fs.rmSync(this.confPath, { force: true });
    fs.rmSync(this.pidPath, { force: true });
  }

  private pidIsSockseek(pid: number): boolean {
    try {
      const out =
        process.platform === "win32"
          ? execFileSync(
              "tasklist",
              ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
              {
                windowsHide: true,
                timeout: 3000,
              },
            ).toString()
          : execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
              timeout: 3000,
            }).toString();
      return /sockseek/i.test(out);
    } catch {
      return false;
    }
  }

  // a crash can leave a daemon (and the plain-text conf) behind
  private killStale(): void {
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(this.pidPath, "utf8")) || 0;
    } catch {}
    if (pid > 0 && this.pidIsSockseek(pid)) {
      try {
        process.kill(pid);
      } catch {}
    }
    fs.rmSync(this.pidPath, { force: true });
    fs.rmSync(this.confPath, { force: true });
  }

  // ---- jobs ----

  private finish(job: InternalJob, state: LosslessJob["state"], error = "") {
    job.state = state;
    job.error = error;
    job.finished = true;
    job.updatedAt = Date.now();
  }

  private ensurePolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, POLL_MS);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollOnce();
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    const active = [...this.jobs.values()].filter(
      (j) => !j.finished && j.ssJobId,
    );
    if (!active.length || !this.proc) {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      return;
    }
    try {
      const status = await this.api<{ soulseekClient?: string }>(
        "GET",
        "/api/server/status",
      );
      this.soulseek = status?.soulseekClient ?? null;
    } catch {}
    for (const job of active) {
      if (job.state === "importing") continue;
      let detail: SockseekJobDetail;
      try {
        detail = await this.api(
          "GET",
          `/api/jobs/${encodeURIComponent(job.ssJobId!)}`,
        );
      } catch {
        continue;
      }
      const summary = detail?.summary;
      const payload = detail?.payload ?? {};
      if (!summary) continue;
      job.updatedAt = Date.now();
      if (typeof payload.progressPercent === "number")
        job.progress = Math.round(payload.progressPercent);
      if (payload.resolvedFilename)
        job.peerFile = String(payload.resolvedFilename).split(/[\\/]/).pop();
      if (payload.resolvedSampleRate)
        job.sampleRate = Number(payload.resolvedSampleRate);
      const depth = (payload.resolvedAttributes ?? []).find(
        (a) => a?.type === "BitDepth",
      );
      if (depth) job.bitDepth = Number(depth.value);
      if (summary.lifecycleState !== "Terminal") {
        job.state =
          payload.transferState || job.progress ? "downloading" : "searching";
        continue;
      }
      if (summary.terminalOutcome !== "Succeeded") {
        this.finish(
          job,
          summary.terminalOutcome === "Cancelled" ? "cancelled" : "failed",
          FAILURE_MESSAGES[summary.failureReason ?? ""] ||
            summary.failureMessage ||
            "Download failed",
        );
        continue;
      }
      const downloaded = payload.downloadPath;
      if (
        payload.downloadSource !== "Soulseek" ||
        !downloaded ||
        !isLosslessExtension(path.extname(downloaded))
      ) {
        if (downloaded) fs.rmSync(downloaded, { force: true });
        this.finish(job, "failed", "Result was not a lossless Soulseek file");
        continue;
      }
      job.state = "importing";
      const filePath = path.resolve(downloaded);
      this.importChain = this.importChain.then(async () => {
        try {
          const patch = await this.deps.onDownloaded(job, filePath);
          Object.assign(job, patch);
          this.finish(
            job,
            patch.state === "skipped" ? "skipped" : "done",
            patch.error,
          );
        } catch (error) {
          fs.rmSync(filePath, { force: true });
          this.finish(
            job,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        this.deps.onChange();
      });
    }
    this.deps.onChange();
  }

  private newJob(
    track: TrackRequest,
    batch: { batchId: string; batchName: string } | null,
  ): InternalJob {
    const query = cleanSoulseekQuery(track);
    const now = Date.now();
    return {
      id: newId(8),
      batchId: batch?.batchId ?? "",
      batchName: batch?.batchName ?? "",
      key: queryKey(query),
      title: track.title || query.title || "",
      artist: track.artist || query.artist || "",
      query: [query.artist, query.title].filter(Boolean).join(" - "),
      cleanArtist: query.artist ?? "",
      cleanTitle: query.title ?? "",
      thumbnail: /^https:\/\//i.test(track.thumbnail ?? "")
        ? track.thumbnail!
        : "",
      preferHiRes: Boolean(track.preferHiRes),
      state: "starting",
      progress: 0,
      error: "",
      createdAt: now,
      updatedAt: now,
    };
  }

  private remember(job: InternalJob) {
    this.jobs.set(job.id, job);
    if (this.jobs.size > MAX_JOBS) {
      const oldest = [...this.jobs.values()].find((j) => j.finished);
      if (oldest) this.jobs.delete(oldest.id);
    }
  }

  async submit(
    track: TrackRequest,
    batch: { batchId: string; batchName: string } | null = null,
  ): Promise<LosslessJob> {
    const query = cleanSoulseekQuery(track);
    if (!query.title) throw new Error("Track title is missing");
    const job = this.newJob(track, batch);
    this.remember(job);
    this.deps.onChange();
    try {
      await this.start();
      const res = await this.api<{ jobId?: string }>(
        "POST",
        "/api/jobs/downloads/song",
        buildSongJobRequest(query, { preferHiRes: job.preferHiRes }),
      );
      if (!res?.jobId) throw new Error("sockseek did not accept the job");
      job.ssJobId = res.jobId;
      job.state = "searching";
      this.ensurePolling();
    } catch (error) {
      this.finish(
        job,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    this.deps.onChange();
    return this.toPublic(job);
  }

  async submitBatch(
    tracks: TrackRequest[],
    options: { name: string; preferHiRes: boolean },
  ): Promise<LosslessBatchSummary> {
    const batch = { batchId: newId(6), batchName: options.name };
    const summary: LosslessBatchSummary = {
      batchId: batch.batchId,
      submitted: 0,
      skipped: 0,
    };
    for (const track of tracks) {
      const query = cleanSoulseekQuery(track);
      if (!query.title) continue;
      const key = queryKey(query);
      const queued = [...this.jobs.values()].some(
        (j) => !j.finished && j.key === key,
      );
      const owned = !queued && (await this.deps.hasLibraryTrack(key));
      if (queued || owned) {
        const job = this.newJob(track, batch);
        this.finish(
          job,
          "skipped",
          owned ? "Already on this device" : "Already in the download queue",
        );
        this.remember(job);
        summary.skipped++;
        continue;
      }
      await this.submit({ ...track, preferHiRes: options.preferHiRes }, batch);
      summary.submitted++;
    }
    this.deps.onChange();
    return summary;
  }

  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.finished) return;
    if (job.ssJobId && this.proc) {
      try {
        await this.api(
          "POST",
          `/api/jobs/${encodeURIComponent(job.ssJobId)}/cancel`,
        );
      } catch {}
    }
    this.finish(job, "cancelled", "Cancelled");
    this.deps.onChange();
  }

  clearFinished(): void {
    for (const [id, job] of this.jobs) {
      if (job.finished) this.jobs.delete(id);
    }
    this.deps.onChange();
  }

  updateJob(localId: string, patch: Partial<LosslessJob>): void {
    for (const job of this.jobs.values()) {
      if (job.localId === localId) Object.assign(job, patch);
    }
    this.deps.onChange();
  }

  private toPublic(job: InternalJob): LosslessJob {
    const {
      key,
      ssJobId,
      finished,
      cleanArtist,
      cleanTitle,
      thumbnail,
      ...rest
    } = job;
    return rest;
  }

  list(): LosslessJob[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((job) => this.toPublic(job));
  }

  status(): Omit<LosslessStatus, "install"> {
    const auth = this.loadAuth();
    const mock = Boolean(this.deps.mockFilesDir);
    return {
      mock,
      secureStorage: this.canStoreAuth(),
      configured: mock || Boolean(auth),
      username: auth?.username ?? "",
      daemon: this.proc ? "running" : this.starting ? "starting" : "stopped",
      soulseek: this.soulseek,
      error: this.error,
    };
  }
}
