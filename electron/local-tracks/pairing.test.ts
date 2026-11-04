import { describe, expect, it } from "vitest";
import { artistsNest, compareCopies, pairKind } from "./pairing";
import type { LocalTrackRecord } from "./types";

const copy = (over: Partial<LocalTrackRecord>): LocalTrackRecord => ({
  id: "a".repeat(20),
  title: "Dưa Chua",
  artist: "RPT MCK",
  durationMs: 182_000,
  fileName: "x",
  audioFile: "x",
  mimeType: "audio/flac",
  byteSize: 1,
  addedAt: 1,
  ...over,
});

describe("artistsNest", () => {
  it("finds one lead artist inside the other", () => {
    expect(artistsNest("MCK", "RPT MCK")).toBe(true);
    expect(artistsNest("RPT MCK & tlinh", "RPT MCK")).toBe(true);
    expect(artistsNest("MCK", "tlinh")).toBe(false);
    expect(artistsNest("", "MCK")).toBe(false);
  });
});

describe("pairKind", () => {
  it("is the same song for one key and one length, ignoring case and Đ", () => {
    expect(
      pairKind(
        copy({ title: "Đao Của Anh Vừa" }),
        copy({ title: "ĐAO CỦA ANH VỪA", durationMs: 183_000 }),
      ),
    ).toBe("same");
  });

  it("flags a different artist spelling for the owner to confirm", () => {
    expect(pairKind(copy({}), copy({ artist: "MCK", source: "youtube" }))).toBe(
      "artist-name",
    );
  });

  it("flags a longer YouTube copy, but never a longer file from elsewhere", () => {
    const video = copy({ source: "youtube", durationMs: 367_000 });
    expect(pairKind(copy({}), video)).toBe("longer-video");
    expect(pairKind(copy({}), { ...video, source: undefined })).toBeNull();
  });

  it("does not pair different songs or unrelated artists", () => {
    expect(pairKind(copy({}), copy({ title: "Xa Xôi" }))).toBeNull();
    expect(pairKind(copy({}), copy({ artist: "Obito" }))).toBeNull();
  });
});

describe("compareCopies", () => {
  it("puts lossless and bigger audio first", () => {
    const flac = copy({ lossless: true, bitDepth: 16, sampleRate: 44100 });
    const hires = copy({ lossless: true, bitDepth: 24, sampleRate: 96000 });
    const opus = copy({ lossless: false, bitrate: 160_000 });
    const sorted = [opus, flac, hires].sort(compareCopies);
    expect(sorted).toEqual([hires, flac, opus]);
  });

  it("breaks a tie toward the copy with album details", () => {
    const bare = copy({ lossless: true, bitDepth: 16, sampleRate: 44100 });
    const tagged = { ...bare, album: "HVL", trackNo: 3 };
    expect([bare, tagged].sort(compareCopies)[0]).toBe(tagged);
  });
});
