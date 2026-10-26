import { describe, expect, it } from "vitest";
import {
  buildSockseekConf,
  buildSongJobRequest,
  classifyUltrasonic,
  cleanSoulseekQuery,
  cleanTitle,
  isLosslessExtension,
  maxItunesArtwork,
  pickBestCover,
  primaryArtist,
} from "./query";

describe("cleanSoulseekQuery", () => {
  it("reduces youtube music metadata to the primary artist and bare title", () => {
    const query = cleanSoulseekQuery({
      title: "Get Lucky (feat. Pharrell Williams and Nile Rodgers)",
      artist: "Daft Punk, Pharrell Williams & Nile Rodgers",
      durationSec: 369.6,
    });
    expect(query).toMatchObject({
      artist: "Daft Punk",
      title: "Get Lucky",
      length: 370,
    });
  });

  it("takes the artist from an 'Artist - Title' title", () => {
    const query = cleanSoulseekQuery({
      title: "Daft Punk - Around the World",
      artist: "",
    });
    expect(query).toMatchObject({
      artist: "Daft Punk",
      title: "Around the World",
      length: null,
    });
  });

  it("drops the length when the source duration is unreliable", () => {
    expect(
      cleanSoulseekQuery({
        title: "x",
        artist: "y",
        durationSec: 250,
        lengthUnreliable: true,
      }).length,
    ).toBeNull();
  });
});

describe("artist and title cleanup", () => {
  it("strips channel suffixes and video noise", () => {
    expect(primaryArtist("Adele - Topic")).toBe("Adele");
    expect(primaryArtist("TaylorSwiftVEVO")).toBe("TaylorSwift");
    expect(primaryArtist("Metro Boomin x Future")).toBe("Metro Boomin");
    expect(primaryArtist("Simon & Garfunkel")).toBe("Simon & Garfunkel");
    expect(cleanTitle("Blinding Lights (Official Audio) [HD]")).toBe(
      "Blinding Lights",
    );
    expect(cleanTitle("Song ft. Someone")).toBe("Song");
  });

  it("keeps version tags that change the recording", () => {
    expect(cleanTitle("Midnight City (Live)")).toBe("Midnight City (Live)");
    expect(cleanTitle("One More Time (Radio Edit)")).toBe(
      "One More Time (Radio Edit)",
    );
  });
});

describe("buildSongJobRequest", () => {
  const query = cleanSoulseekQuery({ title: "x", artist: "y" });

  it("requires a playable lossless file and turns the yt-dlp fallback off", () => {
    const request = buildSongJobRequest(query);
    const search = request.options.downloadSettings.search;
    expect(search.necessaryCond.formats.replace).toEqual(["flac", "wav"]);
    expect(search.necessaryCond.lengthTolerance).toBe(15);
    expect(search.preferredCond).toEqual({ lengthTolerance: 3 });
    expect(request.options.downloadSettings.ytDlp.useYtdlp).toBe(false);
    expect(request.downloadBehavior.default).toBe("Automatic");
  });

  it("ranks hi-res files first when asked", () => {
    expect(
      buildSongJobRequest(query, { preferHiRes: true }).options.downloadSettings
        .search.preferredCond,
    ).toEqual({
      lengthTolerance: 3,
      minBitDepth: 24,
      minSampleRate: 88200,
      maxSampleRate: 384000,
      maxBitrate: 20000,
    });
  });
});

describe("buildSockseekConf", () => {
  it("quotes values and rejects multi-line input", () => {
    const conf = buildSockseekConf({ username: "me", password: " p=ss#1 " });
    expect(conf).toMatch(/^username = "me"$/m);
    expect(conf).toMatch(/^password = " p=ss#1 "$/m);
    expect(() =>
      buildSockseekConf({ username: "me", password: "a\nb" }),
    ).toThrow();
    expect(() => buildSockseekConf({ username: "", password: "x" })).toThrow();
  });
});

it("checks lossless extensions", () => {
  expect(isLosslessExtension(".FLAC")).toBe(true);
  expect(isLosslessExtension("wav")).toBe(true);
  expect(isLosslessExtension(".mp3")).toBe(false);
  expect(isLosslessExtension(".ape")).toBe(false);
});

it("asks itunes for the largest original artwork", () => {
  expect(
    maxItunesArtwork(
      "https://is1-ssl.mzstatic.com/image/thumb/a/b.jpg/100x100bb.jpg",
    ),
  ).toBe(
    "https://is1-ssl.mzstatic.com/image/thumb/a/b.jpg/3000x3000bb-100.jpg",
  );
  expect(maxItunesArtwork("https://example.com/x.jpg")).toBe(
    "https://example.com/x.jpg",
  );
});

it("picks the largest cover and breaks ties by source", () => {
  expect(
    pickBestCover([
      { source: "embedded", width: 500, height: 500, rank: 1 },
      { source: "itunes", width: 1500, height: 1500, rank: 0 },
      { source: "stream", width: 0, height: 0, rank: 2 },
    ])?.source,
  ).toBe("itunes");
  expect(
    pickBestCover([
      { source: "embedded", width: 1000, height: 1000, rank: 1 },
      { source: "itunes", width: 1000, height: 1000, rank: 0 },
    ])?.source,
  ).toBe("itunes");
  expect(pickBestCover([])).toBeNull();
});

it("marks upsampled files by the cliff above 22 kHz", () => {
  expect(classifyUltrasonic(-39.9, -104.8)).toBe("upsampled");
  expect(classifyUltrasonic(-39.8, -39.5)).toBe("hires");
  expect(classifyUltrasonic(-60, -61)).toBe("hires");
  expect(classifyUltrasonic(-130, -140)).toBe("unknown");
  expect(classifyUltrasonic(-40, -Infinity)).toBe("upsampled");
});

it("marks upsampled files by the silence above 30 kHz", () => {
  // ffmpeg's default resampler: residue just above 24 kHz, nothing further up
  expect(classifyUltrasonic(-47.5, -82.7, -142.4)).toBe("upsampled");
  expect(classifyUltrasonic(-47.2, -46.9, -45.9)).toBe("hires");
  expect(classifyUltrasonic(-60, -85, -112)).toBe("hires");
});
