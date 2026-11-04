import { describe, expect, it } from "vitest";
import { recordMatchKey, trackMatchKey } from "./downloadMatch";
import type { LocalTrackRecord } from "@/shared/media/local";

describe("downloadMatch", () => {
  it("matches a catalog row to the same song despite decoration", () => {
    expect(trackMatchKey("Lover Girl (Official Audio)", "Lauv")).toBe(
      trackMatchKey("Lover Girl", "Lauv, Someone"),
    );
  });

  it("builds a readable key", () => {
    expect(trackMatchKey("Lover Girl (Official Audio)", "Lauv")).toBe(
      "lauv\u0000lover girl",
    );
  });

  it("ignores case and youtube topic channels", () => {
    expect(trackMatchKey("lover girl", "LAUV - Topic")).toBe(
      trackMatchKey("Lover Girl", "Lauv"),
    );
  });

  it("has no key for a row without a title or an artist", () => {
    expect(trackMatchKey("", "Lauv")).toBeNull();
    expect(trackMatchKey("Lover Girl", "")).toBeNull();
  });

  it("meets across accents, punctuation, ampersands and remaster labels", () => {
    expect(trackMatchKey("love.", "wave to earth")).toBe(
      trackMatchKey("Love", "Wave To Earth"),
    );
    expect(trackMatchKey("Déjà Vu", "Beyoncé")).toBe(
      trackMatchKey("Deja Vu", "Beyonce"),
    );
    expect(trackMatchKey("Dreams - 2004 Remaster", "Fleetwood Mac")).toBe(
      trackMatchKey("Dreams (Remastered)", "Fleetwood Mac"),
    );
    expect(trackMatchKey("Closer - Single", "The Chainsmokers")).toBe(
      trackMatchKey("Closer", "The Chainsmokers"),
    );
  });

  it("folds the stroke of Đ, which is not an accent", () => {
    expect(trackMatchKey("Đao Của Anh Vừa", "RPT MCK")).toBe(
      trackMatchKey("DAO CUA ANH VUA", "rpt mck"),
    );
  });

  it("keeps live and remix recordings apart from the studio song", () => {
    expect(trackMatchKey("Lover Girl (Live)", "Lauv")).not.toBe(
      trackMatchKey("Lover Girl", "Lauv"),
    );
  });

  it("folds the downloader's stamped key the same way", () => {
    const record = {
      title: "x",
      artist: "y",
      matchKey: "wave to earth\u0000love.",
    } as LocalTrackRecord;
    expect(recordMatchKey(record)).toBe(trackMatchKey("Love", "wave to earth"));
  });

  it("prefers the key stamped by the downloader", () => {
    const record = {
      title: "x",
      artist: "y",
      matchKey: "stamped",
    } as LocalTrackRecord;
    expect(recordMatchKey(record)).toBe("stamped");
  });
});
