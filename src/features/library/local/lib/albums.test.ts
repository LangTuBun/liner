import { describe, expect, it } from "vitest";
import { groupLocalAlbums } from "./albums";
import type { LocalTrackRecord } from "@/shared/media/local";

const record = (over: Partial<LocalTrackRecord>): LocalTrackRecord => ({
  id: "a".repeat(20),
  title: "t",
  artist: "The Weeknd",
  durationMs: 1000,
  fileName: "x.flac",
  audioFile: "x.flac",
  mimeType: "audio/flac",
  byteSize: 1,
  addedAt: 1,
  ...over,
});

describe("groupLocalAlbums", () => {
  it("groups by album and first artist, ordered by disc then track", () => {
    const albums = groupLocalAlbums([
      record({
        id: "3".padEnd(20, "0"),
        title: "Three",
        album: "After Hours",
        trackNo: 3,
      }),
      record({
        id: "1".padEnd(20, "0"),
        title: "One",
        album: "After Hours",
        trackNo: 1,
      }),
      record({
        id: "d".padEnd(20, "0"),
        title: "Disc two",
        album: "After Hours",
        trackNo: 1,
        discNo: 2,
        artist: "The Weeknd, Ariana Grande",
      }),
      record({
        id: "2".padEnd(20, "0"),
        title: "Two",
        album: "After Hours",
        trackNo: 2,
      }),
    ]);
    expect(albums).toHaveLength(1);
    expect(albums[0].artist).toBe("The Weeknd");
    expect(albums[0].tracks.map((t) => t.title)).toEqual([
      "One",
      "Two",
      "Three",
      "Disc two",
    ]);
  });

  it("falls back to the number in the file name, and skips untagged songs", () => {
    const albums = groupLocalAlbums([
      record({
        id: "b".padEnd(20, "0"),
        title: "Later",
        album: "A",
        fileName: "10. Later.dsf",
      }),
      record({
        id: "c".padEnd(20, "0"),
        title: "Earlier",
        album: "A",
        fileName: "2. Earlier.dsf",
      }),
      record({ id: "e".padEnd(20, "0"), title: "Loose" }),
    ]);
    expect(albums).toHaveLength(1);
    expect(albums[0].tracks.map((t) => t.title)).toEqual(["Earlier", "Later"]);
  });

  it("keeps one album together when guests change the credited artist", () => {
    const albums = groupLocalAlbums([
      record({ id: "1".padEnd(20, "0"), album: "99%", artist: "RPT MCK" }),
      record({
        id: "2".padEnd(20, "0"),
        album: "99%",
        artist: "RPT MCK & Trung Trần",
      }),
      record({
        id: "3".padEnd(20, "0"),
        album: "99%",
        artist: "RPT MCK & tlinh",
      }),
    ]);
    expect(albums).toHaveLength(1);
    expect(albums[0].artist).toBe("RPT MCK");
    expect(albums[0].tracks).toHaveLength(3);
  });

  it("keeps two artists' albums with the same title apart", () => {
    const albums = groupLocalAlbums([
      record({ id: "f".padEnd(20, "0"), album: "Greatest Hits" }),
      record({
        id: "9".padEnd(20, "0"),
        album: "Greatest Hits",
        artist: "Queen",
      }),
    ]);
    expect(albums).toHaveLength(2);
  });
});
