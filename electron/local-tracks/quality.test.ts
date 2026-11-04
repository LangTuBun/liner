import { describe, expect, it } from "vitest";
import { compareLocalQuality } from "./quality";

const flac16 = { lossless: true, bitDepth: 16, sampleRate: 44100 };

describe("compareLocalQuality", () => {
  it("ranks lossless above lossy", () => {
    const opus = { lossless: false, bitrate: 128000, mimeType: "audio/ogg" };
    expect(compareLocalQuality(flac16, opus)).toBe("better");
    expect(compareLocalQuality(opus, flac16)).toBe("worse");
  });

  it("ranks higher resolution above CD quality", () => {
    const dsd = { lossless: true, bitDepth: 24, sampleRate: 176400 };
    expect(compareLocalQuality(dsd, flac16)).toBe("better");
    expect(compareLocalQuality(flac16, dsd)).toBe("worse");
    expect(compareLocalQuality(flac16, { ...flac16 })).toBe("equal");
  });

  it("will not call mixed evidence an upgrade", () => {
    const deepSlow = { lossless: true, bitDepth: 24, sampleRate: 44100 };
    const shallowFast = { lossless: true, bitDepth: 16, sampleRate: 96000 };
    expect(compareLocalQuality(deepSlow, shallowFast)).toBe("unknown");
  });

  it("is unknown without facts, and across lossy codecs", () => {
    expect(compareLocalQuality({}, flac16)).toBe("unknown");
    expect(compareLocalQuality({ lossless: true }, flac16)).toBe("unknown");
    const mp3 = { lossless: false, bitrate: 320000, mimeType: "audio/mpeg" };
    const opus = { lossless: false, bitrate: 128000, mimeType: "audio/ogg" };
    expect(compareLocalQuality(mp3, opus)).toBe("unknown");
    expect(compareLocalQuality(mp3, { ...mp3, bitrate: 128000 })).toBe(
      "better",
    );
  });
});
