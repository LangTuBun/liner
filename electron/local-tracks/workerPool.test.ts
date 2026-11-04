// @vitest-environment node
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import { convertDsfToWav } from "./dsf.js";
import { hashFile } from "./importer.js";
import { dsf, modulate, RATE, SECONDS } from "./dsf.fixture.js";
import { LocalTrackLibrary } from "./library.js";
import { LocalTrackWorkerPool } from "./workerPool.js";
import type { LocalTrackTask } from "./workerTask.js";

describe("local track workers", () => {
  let dir: string;
  let pool: LocalTrackWorkerPool;
  let jobs: { source: string; reference: string }[];
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "liner-worker-test-"));
    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        outDir: path.join(dir, "build"),
        lib: {
          entry: path.resolve("electron/local-tracks/local-track-worker.ts"),
          formats: ["cjs"],
          fileName: () => "worker.cjs",
        },
        rolldownOptions: {
          platform: "node",
          external: [/^node:/],
          output: { codeSplitting: false },
        },
      },
    });
    pool = new LocalTrackWorkerPool(
      2,
      pathToFileURL(path.join(dir, "build/worker.cjs")),
    );
    const bytes = Math.round((RATE * SECONDS) / 8);
    const tone = modulate(
      bytes,
      (n) => 0.5 * Math.sin((2 * Math.PI * 1000 * n) / RATE),
    );
    const fixtures = [
      dsf(tone),
      dsf(tone, Buffer.alloc(bytes, 0x69)),
      dsf(Buffer.alloc(bytes, 255), tone),
    ];
    jobs = await Promise.all(
      fixtures.map(async (data, i) => {
        const source = path.join(dir, `${i}.dsf`);
        await fs.writeFile(source, data);
        const reference = path.join(dir, `${i}-reference.wav`);
        await convertDsfToWav(source, reference);
        return { source, reference };
      }),
    );
    await fs.writeFile(path.join(dir, "broken.dsf"), Buffer.alloc(200));
  }, 30_000);
  afterAll(() => fs.rm(dir, { recursive: true, force: true }));

  it("matches in-thread mono, stereo, and lower-gain output with two workers", async () => {
    const prepared = await Promise.all(
      jobs.map(({ source }, i) =>
        pool.run({
          kind: "prepare",
          source,
          root: path.join(dir, `prepared-${i}`),
        }),
      ),
    );
    expect(prepared.map((p) => path.basename(p!.file.source))).toEqual([
      "0.dsf",
      "1.dsf",
      "2.dsf",
    ]);
    for (const [i, result] of prepared.entries())
      expect(
        await fs.readFile(
          path.join(result!.root, "audio", result!.record!.audioFile),
        ),
      ).toEqual(await fs.readFile(jobs[i].reference));
  });

  it("commits in input order, checkpoints, dedupes, and isolates a bad file", async () => {
    const root = path.join(dir, "library");
    const broken = path.join(dir, "broken.dsf");
    const checkpoints: number[] = [];
    const progress: number[] = [];
    const library = new LocalTrackLibrary(
      root,
      () => {
        checkpoints.push(
          JSON.parse(readFileSync(path.join(root, "library.json"), "utf8"))
            .length,
        );
      },
      { workers: pool, onProgress: (p) => progress.push(p.done) },
    );
    const result = await library.importFiles([
      path.join(dir, "0.dsf"),
      broken,
      path.join(dir, "1.dsf"),
      path.join(dir, "0.dsf"),
    ]);
    expect(result.added.map((r) => r.fileName)).toEqual(["0.dsf", "1.dsf"]);
    expect(result.duplicates).toBe(1);
    expect(result.failed).toEqual(["broken.dsf"]);
    expect(checkpoints).toEqual([1, 2]);
    expect(progress).toEqual([0, 1, 2, 3, 4]);
    expect(await fs.readdir(root)).toEqual(
      expect.arrayContaining(["audio", "covers", "library.json"]),
    );
    expect(
      (await fs.readdir(root)).some((name) => name.startsWith(".import-")),
    ).toBe(false);
    expect(
      (await fs.readdir(path.join(root, "audio"))).some((name) =>
        name.endsWith(".part"),
      ),
    ).toBe(false);
  });

  it("skips known hashes before preparing audio", async () => {
    const source = jobs[0].source;
    const root = path.join(dir, "known-file");
    expect(
      await pool.run({
        kind: "prepare",
        source,
        root,
        known: [await hashFile(source)],
      }),
    ).toBeNull();
    await expect(fs.access(root)).rejects.toThrow();
  });

  it("serializes overlapping batches without duplicating a record", async () => {
    const library = new LocalTrackLibrary(
      path.join(dir, "overlapping-batches"),
      undefined,
      { workers: pool },
    );
    const [first, second] = await Promise.all([
      library.importFiles([jobs[0].source, jobs[1].source]),
      library.importFiles([jobs[1].source, jobs[2].source]),
    ]);
    expect(first.added).toHaveLength(2);
    expect(second.added).toHaveLength(1);
    expect(second.duplicates).toBe(1);
    expect((await library.list()).map((record) => record.fileName)).toEqual([
      "0.dsf",
      "1.dsf",
      "2.dsf",
    ]);
  });

  it("releases the library queue during preparation and preserves intervening edits", async () => {
    const root = path.join(dir, "responsive-library");
    const library = new LocalTrackLibrary(root, undefined, { workers: pool });
    await library.importFiles([path.join(dir, "0.dsf")]);
    const original = (await library.list())[0];
    const actual = pool.run.bind(pool);
    const run = vi.spyOn(pool, "run");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    run.mockImplementationOnce(async (task: LocalTrackTask) => {
      await gate;
      return actual(task);
    });
    const importing = library.importFiles([path.join(dir, "1.dsf")]);
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    await library.update(original.id, { title: "Edited during import" });
    expect((await library.list())[0].title).toBe("Edited during import");
    release();
    await importing;
    expect((await library.list())[0].title).toBe("Edited during import");
    run.mockRestore();
  });

  it("still skips a duplicate when its speculative conversion fails", async () => {
    const library = new LocalTrackLibrary(
      path.join(dir, "duplicate-library"),
      undefined,
      { workers: pool },
    );
    const source = path.join(dir, "0.dsf");
    await library.importFiles([source]);
    const actual = pool.run.bind(pool);
    const run = vi
      .spyOn(pool, "run")
      .mockImplementationOnce(async (task: LocalTrackTask) => {
        const prepared = await actual(
          task.kind === "prepare" ? { ...task, known: [] } : task,
        );
        if (!prepared || !("file" in prepared))
          throw new Error("Expected preparation");
        return { ...prepared, record: undefined, error: "Disk full" };
      });
    try {
      const result = await library.importFiles([source]);
      expect(result.duplicates).toBe(1);
      expect(result.failed).toEqual([]);
    } finally {
      run.mockRestore();
    }
  });

  it("cleans staging after a worker crash and continues with the next file", async () => {
    const entry = path.join(dir, "crash.cjs");
    const realEntry = path.join(dir, "build/worker.cjs");
    await fs.writeFile(
      entry,
      `const {workerData}=require('node:worker_threads');
      if(workerData.source.endsWith('broken.dsf')) {
        const fs=require('node:fs'); const path=require('node:path');
        fs.mkdirSync(workerData.root,{recursive:true});
        fs.writeFileSync(path.join(workerData.root,'crash.wav.part'),'partial');
        process.exit(17);
      } else import(${JSON.stringify(pathToFileURL(realEntry).href)});`,
    );
    const workers = new LocalTrackWorkerPool(2, pathToFileURL(entry));
    const root = path.join(dir, "crash-library");
    const result = await new LocalTrackLibrary(root, undefined, {
      workers,
    }).importFiles([path.join(dir, "broken.dsf"), path.join(dir, "2.dsf")]);
    expect(result.failed).toEqual(["broken.dsf"]);
    expect(result.added.map((r) => r.fileName)).toEqual(["2.dsf"]);
    expect(
      (await fs.readdir(root)).some((name) => name.startsWith(".import-")),
    ).toBe(false);
  });
});
