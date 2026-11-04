import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalTrackLibrary } from "./library";
import { wavHeader } from "./wav";
import { vi } from "vitest";
import * as loudnessWav from "./loudnessWav";

describe("LocalTrackLibrary", () => {
  let root: string;
  let sources: string;

  const source = async (name: string, content: string) => {
    const file = path.join(sources, name);
    await fs.writeFile(file, content);
    return file;
  };

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "liner-local-"));
    root = path.join(base, "library");
    sources = path.join(base, "sources");
    await fs.mkdir(sources);
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  it("copies audio into its own folder and names tracks from the file name", async () => {
    const library = new LocalTrackLibrary(root);
    const file = await source(
      "03 - Boards of Canada - Roygbiv.mp3",
      "not really mp3",
    );
    const result = await library.importFiles([file]);

    expect(result.added).toHaveLength(1);
    const [record] = result.added;
    expect(record).toMatchObject({
      artist: "Boards of Canada",
      title: "Roygbiv",
      mimeType: "audio/mpeg",
    });
    await expect(
      fs.readFile(path.join(root, "audio", record.audioFile), "utf8"),
    ).resolves.toBe("not really mp3");

    await fs.rm(file);
    expect(await new LocalTrackLibrary(root).list()).toEqual([record]);
  });

  it("skips the same file twice and rejects files that are not audio", async () => {
    const library = new LocalTrackLibrary(root);
    const first = await source("a.flac", "same bytes");
    const copy = await source("b.flac", "same bytes");
    const notes = await source("notes.txt", "hello");

    const result = await library.importFiles([first, copy, notes]);

    expect(result.added).toHaveLength(1);
    expect(result.duplicates).toBe(1);
    expect(result.failed).toEqual(["notes.txt"]);
  });

  it("removes the record together with its files", async () => {
    const library = new LocalTrackLibrary(root);
    const { added } = await library.importFiles([
      await source("song.ogg", "ogg"),
    ]);
    const [record] = added;

    await library.remove([record.id]);

    expect(await library.list()).toEqual([]);
    expect(await library.locate("audio", record.id)).toBeNull();
    await expect(
      fs.access(path.join(root, "audio", record.audioFile)),
    ).rejects.toThrow();
  });

  it("refuses an audio-named link that points at a non-audio file", async () => {
    const library = new LocalTrackLibrary(root);
    const secret = await source("id_rsa", "private key");
    const disguised = path.join(sources, "song.mp3");
    await fs.symlink(secret, disguised);

    const result = await library.importFiles([disguised]);

    expect(result.added).toEqual([]);
    expect(result.failed).toEqual(["song.mp3"]);
  });

  it("updates a record and gives it a cover when it has none", async () => {
    const library = new LocalTrackLibrary(root);
    const { added } = await library.importFiles([
      await source("Artist - Song.wav", "wav"),
    ]);
    const [record] = added;

    const updated = await library.update(
      record.id,
      { source: "soulseek", matchKey: "artist\u0000song", hiRes: null },
      { data: Buffer.from("png"), extension: "png" },
    );

    expect(updated).toMatchObject({
      source: "soulseek",
      coverFile: `${record.id}.png`,
    });
    expect((await library.list())[0].matchKey).toBe("artist\u0000song");
    await expect(
      fs.readFile(path.join(root, "covers", `${record.id}.png`), "utf8"),
    ).resolves.toBe("png");
    expect(await library.update("missing", { hiRes: "hires" })).toBeNull();
  });

  it("removes every track with its files and reports the space they used", async () => {
    const library = new LocalTrackLibrary(root);
    await library.importFiles([
      await source("One - A.mp3", "aaaa"),
      await source("Two - B.mp3", "bbbbbb"),
    ]);
    const usage = await library.usage();
    expect(usage.count).toBe(2);
    expect(usage.bytes).toBeGreaterThanOrEqual(10);

    expect(await library.removeAll()).toBe(2);
    expect(await library.list()).toEqual([]);
    await expect(fs.access(path.join(root, "audio"))).rejects.toThrow();
    expect(await library.usage()).toEqual({ count: 0, bytes: 0 });
  });

  it("imports a folder's audio in name order, nested too, and saves as it goes", async () => {
    const album = path.join(sources, "Album");
    await fs.mkdir(path.join(album, "CD2"), { recursive: true });
    await fs.writeFile(path.join(album, "10 - Ten.mp3"), "ten");
    await fs.writeFile(path.join(album, "2 - Two.mp3"), "two");
    await fs.writeFile(path.join(album, "cover.jpg"), "not audio");
    await fs.writeFile(path.join(album, "CD2", "1 - Three.flac"), "three");

    const library = new LocalTrackLibrary(root);
    const result = await library.importFiles([album]);

    expect(result.failed).toEqual([]);
    expect(result.added.map((r) => r.fileName)).toEqual([
      "2 - Two.mp3",
      "10 - Ten.mp3",
      "1 - Three.flac",
    ]);
    expect(await library.list()).toHaveLength(3);
  });

  describe("upgrades", () => {
    it("stores loudness once and recomputes after replacing the audio", async () => {
      const spy = vi.spyOn(loudnessWav, "measureWav");
      try {
        const library = new LocalTrackLibrary(root);
        const makeTone = async (folder: string, bits: 16 | 24, db: number) => {
          const rate = 44100;
          const data = Buffer.alloc((rate * 2 * bits) / 8);
          for (let i = 0; i < rate; i++) {
            const sample = Math.round(
              Math.sin((2 * Math.PI * 997 * i) / rate) *
                10 ** (db / 20) *
                (2 ** (bits - 1) - 1),
            );
            for (let c = 0; c < 2; c++)
              data.writeIntLE(sample, ((i * 2 + c) * bits) / 8, bits / 8);
          }
          const dir = path.join(sources, folder);
          await fs.mkdir(dir);
          const file = path.join(dir, "Artist - Song.wav");
          await fs.writeFile(
            file,
            Buffer.concat([wavHeader(rate, 2, rate, bits), data]),
          );
          return file;
        };
        const original = await makeTone("original", 16, -23);
        const {
          added: [first],
        } = await library.importFiles([original]);
        await library.measureLoudness();
        const measured = (await library.list())[0];
        expect(measured.loudnessLufs).toBeCloseTo(-23, 1);
        expect(measured.peakDb).toBeCloseTo(-23, 2);
        const stored = JSON.parse(
          await fs.readFile(path.join(root, "library.json"), "utf8"),
        );
        expect(stored[0].loudnessLufs).toBe(measured.loudnessLufs);
        await new LocalTrackLibrary(root).measureLoudness();
        await library.measureLoudness();
        expect(spy).toHaveBeenCalledTimes(1);
        const better = await makeTone("better", 24, -20);
        await library.importFiles([better], { upgrade: true });
        expect((await library.list())[0].id).toBe(first.id);
        expect((await library.list())[0].loudnessLufs).toBeUndefined();
        expect(
          await library.storeLoudness(
            first.id,
            first.audioFile,
            first.contentHash,
            { loudnessLufs: -23, peakDb: -23 },
          ),
        ).toBe(false);
        await library.measureLoudness();
        expect((await library.list())[0].loudnessLufs).toBeCloseTo(-20, 1);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(
          await fs.readFile(
            path.join(root, "audio", (await library.list())[0].audioFile),
          ),
        ).toEqual(await fs.readFile(better));
      } finally {
        spy.mockRestore();
      }
    });
    const wav = (bits: number, rate: number) => {
      const frames = Math.round(rate * 0.1);
      const data = Buffer.alloc(frames * 2 * (bits / 8));
      const head = Buffer.alloc(44);
      head.write("RIFF", 0);
      head.writeUInt32LE(36 + data.length, 4);
      head.write("WAVEfmt ", 8);
      head.writeUInt32LE(16, 16);
      head.writeUInt16LE(1, 20);
      head.writeUInt16LE(2, 22);
      head.writeUInt32LE(rate, 24);
      head.writeUInt32LE(rate * 2 * (bits / 8), 28);
      head.writeUInt16LE(2 * (bits / 8), 32);
      head.writeUInt16LE(bits, 34);
      head.write("data", 36);
      head.writeUInt32LE(data.length, 40);
      return Buffer.concat([head, data]);
    };
    const song = async (
      folder: string,
      bits: number,
      rate: number,
      name = "Artist - Song.wav",
    ) => {
      const dir = path.join(sources, folder);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, name);
      await fs.writeFile(file, wav(bits, rate));
      return file;
    };

    it("swaps a better copy in under the same id, and drops the old file", async () => {
      const library = new LocalTrackLibrary(root);
      const first = await library.importFiles([await song("a", 16, 44100)], {
        upgrade: true,
      });
      const [old] = first.added;

      const second = await library.importFiles([await song("b", 24, 96000)], {
        upgrade: true,
      });

      expect(second.added).toEqual([]);
      expect(second.upgraded).toHaveLength(1);
      const list = await library.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: old.id,
        bitDepth: 24,
        sampleRate: 96000,
        addedAt: old.addedAt,
      });
      expect(list[0].audioFile).not.toBe(old.audioFile);
      await expect(
        fs.access(path.join(root, "audio", old.audioFile)),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(root, "audio", list[0].audioFile)),
      ).resolves.toBeUndefined();
    });

    it("keeps the stored copy when the new one is worse, and says so", async () => {
      const library = new LocalTrackLibrary(root);
      await library.importFiles([await song("a", 24, 96000)], {
        upgrade: true,
      });

      const again = await library.importFiles([await song("b", 16, 44100)], {
        upgrade: true,
      });

      expect(again.added).toEqual([]);
      expect(again.upgraded).toBeUndefined();
      expect(again.kept).toBe(1);
      expect(await library.list()).toHaveLength(1);
    });

    it("removes the other copies a better file outranks, and keeps their ids working", async () => {
      const library = new LocalTrackLibrary(root);
      const first = await library.importFiles([await song("a", 16, 44100)]);
      const second = await library.importFiles([await song("b", 16, 48000)]);
      const [slower] = first.added;
      const [faster] = second.added;

      const better = await library.importFiles([await song("c", 24, 96000)], {
        upgrade: true,
      });

      expect(better.upgraded).toHaveLength(1);
      const list = await library.list();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(faster.id);
      await expect(
        fs.access(path.join(root, "audio", slower.audioFile)),
      ).rejects.toThrow();
      const found = await library.locate("audio", slower.id);
      expect(found?.record.id).toBe(faster.id);
    });

    it("plans copies of one song, best first, and removes only approved ones", async () => {
      const library = new LocalTrackLibrary(root);
      const low = await library.importFiles([await song("a", 16, 44100)]);
      const high = await library.importFiles([await song("b", 24, 96000)]);
      const [loser] = low.added;
      const [winner] = high.added;

      const groups = await library.tidyPlan();
      expect(groups).toHaveLength(1);
      expect(groups[0].winner.id).toBe(winner.id);
      expect(groups[0].losers).toMatchObject([
        { reason: "same", certainty: "sure", record: { id: loser.id } },
      ]);

      expect(await library.tidyApply([winner.id])).toBe(0);
      expect(await library.list()).toHaveLength(2);

      expect(await library.tidyApply([loser.id])).toBe(1);
      expect((await library.list()).map((r) => r.id)).toEqual([winner.id]);
      expect((await library.locate("audio", loser.id))?.record.id).toBe(
        winner.id,
      );
    });

    it("asks before treating another artist spelling as the same song", async () => {
      const library = new LocalTrackLibrary(root);
      await library.importFiles([
        await song("a", 16, 44100, "MCK - Song.wav"),
        await song("b", 24, 96000, "RPT MCK - Song.wav"),
      ]);
      const [group] = await library.tidyPlan();
      expect(group.winner.artist).toBe("RPT MCK");
      expect(group.losers[0]).toMatchObject({
        reason: "artist-name",
        certainty: "maybe",
      });
    });

    it("adds a second copy when upgrades are off, as the downloader does", async () => {
      const library = new LocalTrackLibrary(root);
      await library.importFiles([await song("a", 16, 44100)]);
      await library.importFiles([await song("b", 24, 96000)]);
      expect(await library.list()).toHaveLength(2);
    });
  });

  describe("apple lossless", () => {
    const fixture = path.join(__dirname, "fixtures", "tone.alac.m4a");

    it("decodes an ALAC file on import, because Chromium cannot play it", async () => {
      const library = new LocalTrackLibrary(root);
      const file = path.join(sources, "Artist - Tone.m4a");
      await fs.copyFile(fixture, file);

      const result = await library.importFiles([file]);

      expect(result.failed).toEqual([]);
      const [record] = result.added;
      expect(record).toMatchObject({
        mimeType: "audio/wav",
        lossless: true,
        bitDepth: 16,
        sampleRate: 44100,
      });
      expect(record.audioFile).toBe(`${record.id}.wav`);
      await expect(
        fs.access(path.join(root, "audio", record.audioFile)),
      ).resolves.toBeUndefined();
    });

    it("repairs an ALAC file kept as it was, under the same id", async () => {
      const id = "abcdef0123456789abcd";
      await fs.mkdir(path.join(root, "audio"), { recursive: true });
      await fs.copyFile(fixture, path.join(root, "audio", `${id}.m4a`));
      const stored = {
        id,
        title: "Tone",
        artist: "Artist",
        durationMs: 500,
        fileName: "tone.m4a",
        audioFile: `${id}.m4a`,
        mimeType: "audio/mp4",
        loudnessLufs: -23,
        peakDb: -20,
        byteSize: 1,
        addedAt: 1,
      };
      await fs.writeFile(
        path.join(root, "library.json"),
        JSON.stringify([stored]),
      );
      const library = new LocalTrackLibrary(root);

      expect(await library.repairAlac()).toBe(1);

      const [record] = await library.list();
      expect(record.loudnessLufs).toBeUndefined();
      expect(record.peakDb).toBeUndefined();
      expect(record).toMatchObject({
        id,
        audioFile: `${id}.wav`,
        mimeType: "audio/wav",
        lossless: true,
        bitDepth: 16,
      });
      await expect(
        fs.access(path.join(root, "audio", `${id}.m4a`)),
      ).rejects.toThrow();
      expect(await library.repairAlac()).toBe(0);
    });

    it("leaves an m4a that is not ALAC alone", async () => {
      const id = "0123456789abcdef0123";
      await fs.mkdir(path.join(root, "audio"), { recursive: true });
      await fs.writeFile(
        path.join(root, "audio", `${id}.m4a`),
        "aac, not alac",
      );
      await fs.writeFile(
        path.join(root, "library.json"),
        JSON.stringify([
          {
            id,
            title: "T",
            artist: "A",
            durationMs: 1,
            fileName: "t.m4a",
            audioFile: `${id}.m4a`,
            mimeType: "audio/mp4",
            byteSize: 1,
            addedAt: 1,
          },
        ]),
      );
      const library = new LocalTrackLibrary(root);
      expect(await library.repairAlac()).toBe(0);
      expect((await library.list())[0].audioFile).toBe(`${id}.m4a`);
    });
  });

  it("refuses ids that could escape the library folder", async () => {
    const library = new LocalTrackLibrary(root);
    expect(await library.locate("audio", "../../etc/passwd")).toBeNull();
  });
});
