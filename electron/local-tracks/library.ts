import fsp from "node:fs/promises";
import path from "node:path";
import {
  commitLocalFile,
  expandAudioPaths,
  hashFile,
  importLocalFile,
  inspectLocalFile,
  upgradedRecord,
  type IncomingFile,
} from "./importer.js";
import { probeLocalAudio } from "./metadata.js";
import { recordMatchKey, trackMatchKey } from "./matchKey.js";
import { compareLocalQuality } from "./quality.js";
import type {
  LocalImportResult,
  LocalLibraryUsage,
  LocalTrackPatch,
  LocalTrackRecord,
} from "./types.js";

const ID_PATTERN = /^[a-f0-9]{20}$/;
const LIBRARY_FOLDERS = ["audio", "covers"] as const;

async function folderBytes(folder: string): Promise<number> {
  try {
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        total += (await fsp.stat(path.join(folder, entry.name))).size;
      } catch {}
    }
    return total;
  } catch {
    return 0;
  }
}

const knownHashes = (records: LocalTrackRecord[]) =>
  new Set(
    records.flatMap((record) =>
      record.contentHash ? [record.id, record.contentHash] : [record.id],
    ),
  );

type Decision =
  { kind: "new" } | { kind: "keep" } | { kind: "upgrade"; index: number };

export class LocalTrackLibrary {
  private records: LocalTrackRecord[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) {}

  private get indexPath() {
    return path.join(this.root, "library.json");
  }

  private filePath(...parts: string[]) {
    return path.join(this.root, ...parts);
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<LocalTrackRecord[]> {
    if (this.records) return this.records;
    try {
      const parsed: unknown = JSON.parse(
        await fsp.readFile(this.indexPath, "utf8"),
      );
      this.records = Array.isArray(parsed)
        ? (parsed as LocalTrackRecord[])
        : [];
    } catch {
      this.records = [];
    }
    return this.records;
  }

  private async save(records: LocalTrackRecord[]) {
    await fsp.mkdir(this.root, { recursive: true });
    const temp = `${this.indexPath}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(records));
    await fsp.rename(temp, this.indexPath);
    this.records = records;
  }

  list(): Promise<LocalTrackRecord[]> {
    return this.serialized(() => this.load());
  }

  // quality of a stored track; older records never saved it, so read the file
  private async qualityOf(records: LocalTrackRecord[], index: number) {
    const record = records[index];
    if (record.lossless !== undefined) return record;
    try {
      const probed = await probeLocalAudio(
        this.filePath("audio", record.audioFile),
      );
      records[index] = {
        ...record,
        lossless: probed.lossless,
        ...(probed.bitDepth ? { bitDepth: probed.bitDepth } : {}),
        ...(probed.sampleRate ? { sampleRate: probed.sampleRate } : {}),
        ...(probed.bitrate ? { bitrate: probed.bitrate } : {}),
      };
    } catch {}
    return records[index];
  }

  // Replace only when exactly one stored song is the same recording and the
  // new file is clearly better. Worse or equal is left out; mixed evidence is
  // added as its own track, as before.
  private async decide(
    records: LocalTrackRecord[],
    file: IncomingFile,
  ): Promise<Decision> {
    const key = trackMatchKey(file.tags.title, file.tags.artist);
    if (!key) return { kind: "new" };
    const sameLength = (record: LocalTrackRecord) =>
      !record.durationMs ||
      !file.tags.durationMs ||
      Math.abs(record.durationMs - file.tags.durationMs) <= 2000;
    const hits = records
      .map((record, index) => ({ record, index }))
      .filter(
        ({ record }) => recordMatchKey(record) === key && sameLength(record),
      );
    if (hits.length !== 1) return { kind: "new" };
    const existing = await this.qualityOf(records, hits[0].index);
    const verdict = compareLocalQuality(
      { ...file.quality, mimeType: file.tags.mimeType },
      existing,
    );
    if (verdict === "better") return { kind: "upgrade", index: hits[0].index };
    return verdict === "unknown" ? { kind: "new" } : { kind: "keep" };
  }

  importFiles(
    paths: string[],
    options: { upgrade?: boolean } = {},
  ): Promise<LocalImportResult> {
    return this.serialized(async () => {
      const records = [...(await this.load())];
      const known = knownHashes(records);
      const result: LocalImportResult = {
        added: [],
        duplicates: 0,
        failed: [],
      };
      await fsp.mkdir(this.filePath("audio"), { recursive: true });
      await fsp.mkdir(this.filePath("covers"), { recursive: true });
      for (const source of await expandAudioPaths(paths)) {
        try {
          const file = await inspectLocalFile(source, known);
          if (!file) {
            result.duplicates += 1;
            continue;
          }
          const decision: Decision = options.upgrade
            ? await this.decide(records, file)
            : { kind: "new" };
          if (decision.kind === "keep") {
            result.kept = (result.kept ?? 0) + 1;
          } else if (decision.kind === "upgrade") {
            const { record, stale } = await upgradedRecord(
              file,
              this.root,
              records[decision.index],
            );
            records[decision.index] = record;
            known.add(file.id);
            await this.save(records);
            // the index no longer names these, so a failed delete only leaks
            for (const old of stale) await fsp.rm(old, { force: true });
            (result.upgraded ??= []).push(record);
          } else {
            const record = await commitLocalFile(file, this.root);
            known.add(record.id);
            records.push(record);
            result.added.push(record);
            // a long album import keeps what is done if it is interrupted
            await this.save(records);
          }
        } catch {
          result.failed.push(path.basename(source));
        }
      }
      return result;
    });
  }

  update(
    id: string,
    patch: LocalTrackPatch,
    cover?: { data: Uint8Array; extension: string },
  ): Promise<LocalTrackRecord | null> {
    return this.serialized(async () => {
      const records = await this.load();
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) return null;
      const next = { ...records[index], ...patch };
      if (cover && !next.coverFile) {
        const coverFile = `${id}.${cover.extension}`;
        await fsp.mkdir(this.filePath("covers"), { recursive: true });
        await fsp.writeFile(this.filePath("covers", coverFile), cover.data);
        next.coverFile = coverFile;
      }
      await this.save(
        records.map((record, i) => (i === index ? next : record)),
      );
      return next;
    });
  }

  // imports files and stamps each record with the metadata it came with; a file
  // already in the library only gets the metadata
  importWithMetadata(
    entries: { source: string; patch: LocalTrackPatch }[],
  ): Promise<{
    imported: number;
    updated: number;
    failed: number;
    ids: string[];
  }> {
    return this.serialized(async () => {
      const records = [...(await this.load())];
      const known = knownHashes(records);
      const tally = {
        imported: 0,
        updated: 0,
        failed: 0,
        ids: [] as string[],
      };
      await fsp.mkdir(this.filePath("audio"), { recursive: true });
      await fsp.mkdir(this.filePath("covers"), { recursive: true });
      for (const { source, patch } of entries) {
        try {
          const added = await importLocalFile(source, this.root, known);
          const id = added?.id ?? (await hashFile(await fsp.realpath(source)));
          if (added) {
            known.add(id);
            records.push(added);
            tally.imported += 1;
          } else tally.updated += 1;
          tally.ids.push(id);
          const index = records.findIndex((record) => record.id === id);
          if (index >= 0) records[index] = { ...records[index], ...patch };
        } catch {
          tally.failed += 1;
        }
      }
      await this.save(records);
      return tally;
    });
  }

  // re-encodes covers that are bigger than the player ever shows
  shrinkCovers(
    shrink: (data: Buffer) => { data: Buffer } | null,
    minBytes: number,
  ): Promise<number> {
    return this.serialized(async () => {
      const records = [...(await this.load())];
      let saved = 0;
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (!record.coverFile) continue;
        const file = this.filePath("covers", record.coverFile);
        try {
          const before = await fsp.stat(file);
          if (before.size <= minBytes) continue;
          const small = shrink(await fsp.readFile(file));
          if (!small) continue;
          const coverFile = `${record.id}.jpg`;
          await fsp.writeFile(this.filePath("covers", coverFile), small.data);
          if (coverFile !== record.coverFile)
            await fsp.rm(file, { force: true });
          records[i] = { ...record, coverFile };
          saved += before.size - small.data.length;
        } catch {}
      }
      if (saved > 0) await this.save(records);
      return saved;
    });
  }

  remove(ids: string[]): Promise<void> {
    return this.serialized(async () => {
      const removing = new Set(ids);
      const records = await this.load();
      const gone = records.filter((record) => removing.has(record.id));
      if (gone.length === 0) return;
      await this.save(records.filter((record) => !removing.has(record.id)));
      for (const record of gone) {
        await fsp.rm(this.filePath("audio", record.audioFile), { force: true });
        if (record.coverFile) {
          await fsp.rm(this.filePath("covers", record.coverFile), {
            force: true,
          });
        }
      }
    });
  }

  removeAll(): Promise<number> {
    return this.serialized(async () => {
      const count = (await this.load()).length;
      await this.save([]);
      for (const folder of LIBRARY_FOLDERS) {
        await fsp.rm(this.filePath(folder), { recursive: true, force: true });
      }
      return count;
    });
  }

  usage(): Promise<LocalLibraryUsage> {
    return this.serialized(async () => {
      const records = await this.load();
      let bytes = 0;
      for (const folder of LIBRARY_FOLDERS) {
        bytes += await folderBytes(this.filePath(folder));
      }
      if (records.length > 0) {
        try {
          bytes += (await fsp.stat(this.indexPath)).size;
        } catch {}
      }
      return { count: records.length, bytes };
    });
  }

  async locate(kind: "audio" | "cover", id: string) {
    if (!ID_PATTERN.test(id)) return null;
    const record = (await this.list()).find((entry) => entry.id === id);
    const file = kind === "audio" ? record?.audioFile : record?.coverFile;
    if (!record || !file) return null;
    return {
      path: this.filePath(kind === "audio" ? "audio" : "covers", file),
      record,
    };
  }
}
