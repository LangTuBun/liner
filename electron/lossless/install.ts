import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// sockseek is AGPL and stays a separate download, checked against pinned hashes
export const SOCKSEEK_VERSION = "3.0.6";
const SOCKSEEK_ASSETS: Record<string, { name: string; sha256: string }> = {
  "win32-x64": {
    name: "sockseek_3.0.6_win-x64.zip",
    sha256: "aa965bdf3bc9b04757380889e1ce96ce1d57fdf89423fb3f7ebf378e469e66c4",
  },
  "linux-x64": {
    name: "sockseek_3.0.6_linux-x64.tar.gz",
    sha256: "91d7d14fa1293afe94ccb0299e0103f8477a558223f62f4027f5712e4bbf521a",
  },
  "linux-arm": {
    name: "sockseek_3.0.6_linux-arm.tar.gz",
    sha256: "d45b87720b6ab006e471f79055ea3865020fae0761b3e9100731729bdff9f7ea",
  },
  "darwin-arm64": {
    name: "sockseek_3.0.6_osx-arm64.tar.gz",
    sha256: "b7b9602b3ea0d8724b2a4dd1370c97f2f1f7175f901e7088dad714352c4926d9",
  },
  "darwin-x64": {
    name: "sockseek_3.0.6_osx-x64.tar.gz",
    sha256: "6211374e1fca1f0b0bb4bfc6395e493c5969416e116a976f87bac4bdb99320fd",
  },
};

export interface InstallState {
  status: "idle" | "downloading" | "done" | "error";
  percent: number;
  error: string;
}

const EXE = process.platform === "win32" ? "sockseek.exe" : "sockseek";

function asset() {
  return SOCKSEEK_ASSETS[`${process.platform}-${process.arch}`] ?? null;
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 120_000 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

async function findFile(dir: string, name: string): Promise<string | null> {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = await findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

export class SockseekInstaller {
  readonly state: InstallState = { status: "idle", percent: 0, error: "" };

  constructor(
    private readonly binDir: string,
    private readonly onChange: () => void,
  ) {}

  get binaryPath(): string {
    return path.join(this.binDir, EXE);
  }

  installed(): boolean {
    return fs.existsSync(this.binaryPath);
  }

  supported(): boolean {
    return asset() !== null;
  }

  async install(): Promise<void> {
    if (this.state.status === "downloading") return;
    const target = asset();
    if (!target) throw new Error("No sockseek build for this system");
    Object.assign(this.state, { status: "downloading", percent: 0, error: "" });
    this.onChange();
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), "liner-sockseek-"));
    const archive = path.join(work, target.name);
    try {
      const res = await fetch(
        `https://github.com/fiso64/sockseek/releases/download/v${SOCKSEEK_VERSION}/${target.name}`,
      );
      if (!res.ok || !res.body)
        throw new Error(`download failed (${res.status})`);
      const total = Number(res.headers.get("content-length")) || 0;
      const hash = crypto.createHash("sha256");
      const out = fs.createWriteStream(archive);
      let done = 0;
      let lastPercent = -1;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        done += chunk.length;
        if (!out.write(chunk))
          await new Promise<void>((resolve) =>
            out.once("drain", () => resolve()),
          );
        const percent = total ? Math.round((done / total) * 100) : 0;
        if (percent !== lastPercent) {
          lastPercent = percent;
          this.state.percent = percent;
          this.onChange();
        }
      }
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );
      if (hash.digest("hex") !== target.sha256)
        throw new Error("sockseek checksum mismatch");
      // windows ships bsdtar, which also unpacks zip files
      const systemTar = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "tar.exe",
      );
      const tar =
        process.platform === "win32" && fs.existsSync(systemTar)
          ? systemTar
          : "tar";
      const unpacked = path.join(work, "unpacked");
      await fsp.mkdir(unpacked);
      await run(tar, ["-xf", archive, "-C", unpacked]);
      const found = await findFile(unpacked, EXE);
      if (!found) throw new Error(`${EXE} not found inside the archive`);
      await fsp.mkdir(this.binDir, { recursive: true });
      await fsp.copyFile(found, this.binaryPath);
      if (process.platform !== "win32") await fsp.chmod(this.binaryPath, 0o755);
      Object.assign(this.state, { status: "done", percent: 100 });
    } catch (error) {
      Object.assign(this.state, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await fsp.rm(work, { recursive: true, force: true });
      this.onChange();
    }
  }
}
