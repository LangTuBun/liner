import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalTrackLibrary } from "./library";

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
    const song = async (folder: string, bits: number, rate: number) => {
      const dir = path.join(sources, folder);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, "Artist - Song.wav");
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

    it("adds a second copy when upgrades are off, as the downloader does", async () => {
      const library = new LocalTrackLibrary(root);
      await library.importFiles([await song("a", 16, 44100)]);
      await library.importFiles([await song("b", 24, 96000)]);
      expect(await library.list()).toHaveLength(2);
    });
  });

  it("refuses ids that could escape the library folder", async () => {
    const library = new LocalTrackLibrary(root);
    expect(await library.locate("audio", "../../etc/passwd")).toBeNull();
  });
});
