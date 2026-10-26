import { describe, expect, it } from "vitest";
import {
  bandwidthVerdict,
  estimateBandwidth,
  formatRate,
  matchEndpoint,
  summarizeSource,
  type OutputEndpoint,
} from "./audioQuality";

describe("summarizeSource", () => {
  it("reads the youtube itag and measures the bitrate from the file size", () => {
    const summary = summarizeSource(
      {
        trackId: "yt",
        origin: "youtube",
        mimeType: 'audio/webm; codecs="opus"',
        codec: "opus",
        bitrate: 160_000,
        contentLength: 3_000_000,
        itag: 251,
      },
      null,
      200,
    );
    expect(summary).toMatchObject({
      codec: "opus",
      container: "webm",
      sampleRate: 48000,
      bitrate: 120_000,
      lossless: false,
    });
  });

  it("takes the codec from the mime type of a cached blob", () => {
    const summary = summarizeSource(
      {
        trackId: "c",
        origin: "cache",
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        codec: "",
        bitrate: 0,
      },
      null,
      0,
    );
    expect(summary).toMatchObject({
      codec: "aac",
      container: "m4a",
      sampleRate: 44100,
      bitrate: null,
    });
  });

  it("uses the probed format for local files", () => {
    const summary = summarizeSource(
      {
        trackId: "l",
        origin: "local",
        mimeType: "",
        codec: "local",
        bitrate: 0,
      },
      {
        container: "FLAC",
        codec: "FLAC",
        codecProfile: "",
        lossless: true,
        sampleRate: 96000,
        bitDepth: 24,
        channels: 2,
        bitrate: 3_000_000,
        durationSec: 240,
      },
      240,
    );
    expect(summary).toMatchObject({
      lossless: true,
      sampleRate: 96000,
      bitDepth: 24,
    });
  });

  it("waits for the probe before describing a local file", () => {
    expect(
      summarizeSource(
        { trackId: "l", origin: "local", mimeType: "", codec: "", bitrate: 0 },
        null,
        0,
      ),
    ).toBeNull();
  });
});

describe("estimateBandwidth", () => {
  it("finds a lossy low-pass", () => {
    const rate = 48000;
    const bins = new Float32Array(8192).map((_, i) =>
      ((i + 0.5) * rate) / 2 / 8192 < 16000 ? -40 : -135,
    );
    const cutoff = estimateBandwidth(bins, rate);
    expect(Math.abs((cutoff ?? 0) - 16000)).toBeLessThan(50);
    expect(bandwidthVerdict(cutoff, rate)).toBe("lossy");
  });

  it("reports full band content", () => {
    const bins = new Float32Array(8192).fill(-50);
    expect(bandwidthVerdict(estimateBandwidth(bins, 44100), 44100)).toBe(
      "full",
    );
  });

  it("gives nothing for silence", () => {
    expect(estimateBandwidth(new Float32Array(1024).fill(-140), 48000)).toBe(
      null,
    );
  });
});

describe("matchEndpoint", () => {
  const speakers: OutputEndpoint = {
    id: "{a}",
    name: "Speakers",
    iface: "Realtek(R) Audio",
    label: "Speakers (Realtek(R) Audio)",
    format: null,
  };

  it("matches chromium's default device label", () => {
    expect(
      matchEndpoint("Default - Speakers (Realtek(R) Audio)", [speakers]),
    ).toBe(speakers);
    expect(matchEndpoint("Headphones (Other)", [speakers])).toBeNull();
  });
});

it("formats sample rates", () => {
  expect(formatRate(44100)).toBe("44.1 kHz");
  expect(formatRate(48000)).toBe("48 kHz");
  expect(formatRate(null)).toBe("—");
});
