import fsp from "node:fs/promises";
import path from "node:path";
import { measureWav } from "./loudnessWav.js";
import type { LoudnessMeasurement } from "./loudness.js";
import {
  commitLocalFile,
  expandAudioPaths,
  hashFile,
  importLocalFile,
  inspectLocalFile,
  upgradedRecord,
  type IncomingFile,
} from "./importer.js";
import { alacFormat, convertAlacToWav } from "./alac.js";
import { probeLocalAudio } from "./metadata.js";
import { recordMatchKey, trackMatchKey } from "./matchKey.js";
import { compareCopies, pairKind } from "./pairing.js";
import { compareLocalQuality } from "./quality.js";
import type {
  LocalImportResult,
  LocalLibraryUsage,
  LocalStamp,
  LocalTrackPatch,
  LocalTrackRecord,
  TidyGroup,
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
  | { kind: "new" }
  | { kind: "keep" }
  // `drop` are the other copies of the song that the better file outranks
  | { kind: "upgrade"; index: number; drop: number[] };

export class LocalTrackLibrary {
  private records: LocalTrackRecord[] | null = null;
  private aliases: Record<string, string> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private measuring: Promise<void> | null = null;
  private readonly attemptedMeasurements = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly onChanged?: () => void,
  ) {}

  measureLoudness(): Promise<void> {
    if (this.measuring) return this.measuring;
    this.measuring = (async () => {
      for (;;) {
        const record = [...(await this.list())]
          .sort((a, b) => b.addedAt - a.addedAt)
          .find(
            (r) =>
              r.audioFile.endsWith(".wav") &&
              r.loudnessLufs === undefined &&
              !this.attemptedMeasurements.has(
                `${r.id}|${r.audioFile}|${r.contentHash}`,
              ),
          );
        if (!record) break;
        this.attemptedMeasurements.add(
          `${record.id}|${record.audioFile}|${record.contentHash}`,
        );
        try {
          const measurement = await measureWav(
            this.filePath("audio", record.audioFile),
          );
          await this.storeLoudness(
            record.id,
            record.audioFile,
            record.contentHash,
            measurement,
          );
        } catch {
          // An unsupported or damaged file must remain playable and importable.
        }
      }
    })().finally(() => {
      this.measuring = null;
    });
    return this.measuring;
  }

  storeLoudness(
    id: string,
    audioFile: string,
    contentHash: string | undefined,
    measurement: LoudnessMeasurement,
  ): Promise<boolean> {
    return this.serialized(async () => {
      const valid = (v: unknown) =>
        v === null ||
        (typeof v === "number" && Number.isFinite(v) && v >= -200 && v <= 24);
      if (!valid(measurement?.loudnessLufs) || !valid(measurement?.peakDb))
        return false;
      const records = await this.load();
      const record = records.find((r) => r.id === id);
      if (
        !record ||
        record.audioFile !== audioFile ||
        record.contentHash !== contentHash ||
        record.loudnessLufs !== undefined
      )
        return false;
      await this.save(
        records.map((r) =>
          r === record
            ? {
                ...r,
                loudnessLufs: measurement.loudnessLufs,
                peakDb: measurement.peakDb,
              }
            : r,
        ),
      );
      return true;
    });
  }

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
    this.onChanged?.();
  }

  // removed copy -> the copy that stayed, so old playlist and queue entries
  // still find a file
  private async loadAliases(): Promise<Record<string, string>> {
    if (this.aliases) return this.aliases;
    try {
      const parsed: unknown = JSON.parse(
        await fsp.readFile(this.filePath("aliases.json"), "utf8"),
      );
      this.aliases =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : {};
    } catch {
      this.aliases = {};
    }
    return this.aliases;
  }

  private async saveAliases(aliases: Record<string, string>) {
    const target = this.filePath("aliases.json");
    await fsp.mkdir(this.root, { recursive: true });
    await fsp.writeFile(`${target}.tmp`, JSON.stringify(aliases));
    await fsp.rename(`${target}.tmp`, target);
    this.aliases = aliases;
  }

  // Drops the copies in `gone` in favour of `winnerId`: the winner picks up
  // album details it lacks, and the files of the dropped copies are returned
  // for the caller to delete once the index is saved.
  private retire(
    records: LocalTrackRecord[],
    winnerId: string,
    gone: Set<string>,
    aliases: Record<string, string>,
  ): { records: LocalTrackRecord[]; stale: string[] } {
    const winner = records.find((record) => record.id === winnerId);
    const losers = records.filter((record) => gone.has(record.id));
    if (!winner || losers.length === 0) return { records, stale: [] };
    const merged: LocalTrackRecord = { ...winner };
    for (const loser of losers) {
      merged.album ??= loser.album;
      merged.trackNo ??= loser.trackNo;
      merged.discNo ??= loser.discNo;
      merged.coverFile ??= loser.coverFile;
    }
    const stale = losers.flatMap((loser) => [
      this.filePath("audio", loser.audioFile),
      ...(loser.coverFile && loser.coverFile !== merged.coverFile
        ? [this.filePath("covers", loser.coverFile)]
        : []),
    ]);
    for (const key of Object.keys(aliases))
      if (gone.has(aliases[key])) aliases[key] = winnerId;
    for (const loser of losers) aliases[loser.id] = winnerId;
    return {
      records: records
        .filter((record) => !gone.has(record.id))
        .map((record) => (record.id === winnerId ? merged : record)),
      stale,
    };
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

  // The new file is compared with the best stored copy of the same song (same
  // key, same length). Clearly better replaces it and outranks the other copies;
  // worse or equal is left out; mixed evidence is added as its own track.
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
    if (hits.length === 0) return { kind: "new" };
    for (const hit of hits) await this.qualityOf(records, hit.index);
    const ranked = hits
      .map((hit) => hit.index)
      .sort((a, b) => compareCopies(records[a], records[b]));
    const verdict = compareLocalQuality(
      { ...file.quality, mimeType: file.tags.mimeType },
      records[ranked[0]],
    );
    if (verdict === "better")
      return { kind: "upgrade", index: ranked[0], drop: ranked.slice(1) };
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
            let next = records.map((entry, i) =>
              i === decision.index ? record : entry,
            );
            if (decision.drop.length > 0) {
              const aliases = await this.loadAliases();
              const out = this.retire(
                next,
                record.id,
                new Set(decision.drop.map((i) => records[i].id)),
                aliases,
              );
              next = out.records;
              stale.push(...out.stale);
              await this.saveAliases(aliases);
            }
            records.splice(0, records.length, ...next);
            known.add(file.id);
            await this.save(records);
            // the index no longer names these, so a failed delete only leaks
            for (const old of stale)
              await fsp.rm(old, { force: true }).catch(() => undefined);
            (result.upgraded ??= []).push(
              records.find((entry) => entry.id === record.id) ?? record,
            );
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

  // Songs that exist more than once. The best copy of each is the one that
  // stays; every other copy is a candidate, "sure" when it is the same song
  // and length, "maybe" when the artist name differs or it is a longer video.
  private async planGroups(records: LocalTrackRecord[]): Promise<TidyGroup[]> {
    const buckets = new Map<string, number[]>();
    records.forEach((record, index) => {
      const title = recordMatchKey(record)?.split("\u0000")[1];
      if (title) buckets.set(title, [...(buckets.get(title) ?? []), index]);
    });
    const groups: TidyGroup[] = [];
    const taken = new Set<number>();
    for (const indexes of buckets.values()) {
      if (indexes.length < 2) continue;
      for (const index of indexes) await this.qualityOf(records, index);
      const ordered = [...indexes].sort((a, b) =>
        compareCopies(records[a], records[b]),
      );
      for (const w of ordered) {
        if (taken.has(w)) continue;
        const losers: TidyGroup["losers"] = [];
        for (const o of ordered) {
          if (o === w || taken.has(o)) continue;
          const reason = pairKind(records[w], records[o]);
          if (!reason) continue;
          taken.add(o);
          losers.push({
            record: records[o],
            reason,
            certainty: reason === "same" ? "sure" : "maybe",
          });
        }
        if (losers.length === 0) continue;
        taken.add(w);
        groups.push({ winner: records[w], losers });
      }
    }
    return groups;
  }

  tidyPlan(): Promise<TidyGroup[]> {
    return this.serialized(async () => {
      const stored = await this.load();
      const records = [...stored];
      const groups = await this.planGroups(records);
      // reading a file's quality is worth keeping
      if (records.some((record, i) => record !== stored[i]))
        await this.save(records);
      return groups;
    });
  }

  // Removes the copies the owner approved. The plan is made again here, so only
  // a copy that is still a candidate behind a better one can go.
  tidyApply(ids: string[]): Promise<number> {
    return this.serialized(async () => {
      const approved = new Set(ids);
      let records = [...(await this.load())];
      const groups = await this.planGroups(records);
      const aliases = await this.loadAliases();
      const stale: string[] = [];
      let removed = 0;
      for (const group of groups) {
        const gone = new Set(
          group.losers
            .filter((loser) => approved.has(loser.record.id))
            .map((loser) => loser.record.id),
        );
        if (gone.size === 0) continue;
        const out = this.retire(records, group.winner.id, gone, aliases);
        records = out.records;
        stale.push(...out.stale);
        removed += gone.size;
      }
      if (removed === 0) return 0;
      await this.save(records);
      await this.saveAliases(aliases);
      // a file that is playing cannot be deleted on Windows; it just stays
      for (const file of stale)
        await fsp.rm(file, { force: true }).catch(() => undefined);
      return removed;
    });
  }

  // An earlier build kept Apple Lossless files as they were, and Chromium
  // cannot play those. Each is decoded to WAV under the same id, so playlists
  // and lyrics are untouched; the .m4a goes only once the WAV is saved.
  repairAlac(): Promise<number> {
    return this.serialized(async () => {
      const records = [...(await this.load())];
      let fixed = 0;
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (record.mimeType !== "audio/mp4") continue;
        const old = this.filePath("audio", record.audioFile);
        if (!(await alacFormat(old))) continue;
        const wavName = `${record.id}.wav`;
        try {
          const done = await convertAlacToWav(
            old,
            this.filePath("audio", wavName),
          );
          records[i] = {
            ...record,
            audioFile: wavName,
            loudnessLufs: undefined,
            peakDb: undefined,
            mimeType: "audio/wav",
            byteSize: (await fsp.stat(this.filePath("audio", wavName))).size,
            lossless: true,
            bitDepth: done.bitDepth,
            sampleRate: done.sampleRate,
          };
          await this.save(records);
          await fsp.rm(old, { force: true }).catch(() => undefined);
          fixed += 1;
        } catch {
          // leave the original in place; the next start tries again
        }
      }
      return fixed;
    });
  }

  // tells a stored song which catalog song it is, so the catalog row plays it
  stamp(stamps: LocalStamp[]): Promise<number> {
    return this.serialized(async () => {
      const wanted = new Map(stamps.map((s) => [s.id, s.matchKey]));
      let changed = 0;
      const records = (await this.load()).map((record) => {
        const matchKey = wanted.get(record.id);
        if (!matchKey || matchKey === record.matchKey) return record;
        changed += 1;
        return { ...record, matchKey };
      });
      if (changed > 0) await this.save(records);
      return changed;
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
    const stayed = (await this.loadAliases())[id] ?? id;
    const record = (await this.list()).find((entry) => entry.id === stayed);
    const file = kind === "audio" ? record?.audioFile : record?.coverFile;
    if (!record || !file) return null;
    return {
      path: this.filePath(kind === "audio" ? "audio" : "covers", file),
      record,
    };
  }
}
