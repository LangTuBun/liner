import { describe, expect, it } from "vitest";
import { recordMatchKey, trackMatchKey } from "./downloadMatch";
import type { LocalTrackRecord } from "@/shared/media/local";

describe("downloadMatch", () => {
  it("matches a catalog row to the same song despite decoration", () => {
    expect(trackMatchKey("Lover Girl (Official Audio)", "Lauv")).toBe(
      trackMatchKey("Lover Girl", "Lauv, Someone"),
    );
  });

  it("ignores case and youtube topic channels", () => {
    expect(trackMatchKey("lover girl", "LAUV - Topic")).toBe(
      trackMatchKey("Lover Girl", "Lauv"),
    );
  });

  it("has no key for a row without a title", () => {
    expect(trackMatchKey("", "Lauv")).toBeNull();
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
