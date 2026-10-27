import { describe, expect, it } from "vitest";
import { extensionForMime } from "./streamImport";

describe("extensionForMime", () => {
  it("maps what youtube serves", () => {
    expect(extensionForMime('audio/webm; codecs="opus"')).toBe("webm");
    expect(extensionForMime("audio/mp4")).toBe("m4a");
    expect(extensionForMime("AUDIO/MP4; codecs=mp4a.40.2")).toBe("m4a");
  });

  it("refuses anything that is not audio the library takes", () => {
    expect(extensionForMime("video/mp4")).toBeNull();
    expect(extensionForMime("")).toBeNull();
  });
});
