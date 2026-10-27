import fsp from "node:fs/promises";
import path from "node:path";
import { hashFile, importLocalFile } from "./importer.js";
import type {
  LocalImportResult,
  LocalTrackPatch,
  LocalTrackRecord,
} from "./types.js";

const ID_PATTERN = /^[a-f0-9]{20}$/;

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

  importFiles(paths: string[]): Promise<LocalImportResult> {
    return this.serialized(async () => {
      const records = [...(await this.load())];
      const known = new Set(records.map((record) => record.id));
      const result: LocalImportResult = {
        added: [],
        duplicates: 0,
        failed: [],
      };
      await fsp.mkdir(this.filePath("audio"), { recursive: true });
      await fsp.mkdir(this.filePath("covers"), { recursive: true });
      for (const source of paths) {
        try {
          const record = await importLocalFile(source, this.root, known);
          if (!record) result.duplicates += 1;
          else {
            known.add(record.id);
            records.push(record);
            result.added.push(record);
          }
        } catch {
          result.failed.push(path.basename(source));
        }
      }
      if (result.added.length > 0) await this.save(records);
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
      const known = new Set(records.map((record) => record.id));
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
