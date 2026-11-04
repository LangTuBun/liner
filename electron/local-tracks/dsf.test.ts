import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertDsfToWav } from "./dsf.js";

import { RATE, SECONDS, dsf, modulate } from "./dsf.fixture.js";

describe("convertDsfToWav", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "liner-dsf-"));
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it("decodes a stereo DSD128 file to 24-bit 176.4 kHz PCM", async () => {
    const bytes = Math.round((RATE * SECONDS) / 8);
    const left = modulate(
      bytes,
      (n) => 0.5 * Math.sin((2 * Math.PI * 1000 * n) / RATE),
    );
    const right = modulate(bytes, () => 0);
    const source = path.join(dir, "a.dsf");
    const dest = path.join(dir, "a.wav");
    await fs.writeFile(source, dsf(left, right));

    const result = await convertDsfToWav(source, dest);
    const wav = await fs.readFile(dest);

    expect(result.sampleRate).toBe(176_400);
    expect(Math.abs(result.frames - 35_280)).toBeLessThan(8);
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    expect(wav.readUInt16LE(34)).toBe(24);
    expect(wav.readUInt32LE(40)).toBe(result.frames * 6);

    // skip the filter warm-up, then compare RMS per channel
    const rms = (channel: number) => {
      let sum = 0;
      let n = 0;
      for (let i = 2000; i < result.frames - 2000; i++) {
        const v = wav.readIntLE(44 + (i * 2 + channel) * 3, 3) / 8388607;
        sum += v * v;
        n++;
      }
      return Math.sqrt(sum / n);
    };
    expect(rms(0)).toBeGreaterThan(0.33);
    expect(rms(0)).toBeLessThan(0.38);
    expect(rms(1)).toBeLessThan(0.02);
  });

  it("lowers the gain instead of clipping a full-scale signal", async () => {
    const bytes = Math.round((RATE * SECONDS) / 8);
    const source = path.join(dir, "loud.dsf");
    const dest = path.join(dir, "loud.wav");
    await fs.writeFile(
      source,
      dsf(Buffer.alloc(bytes, 0xff), Buffer.alloc(bytes, 0x69)),
    );

    const { frames } = await convertDsfToWav(source, dest);
    const wav = await fs.readFile(dest);
    let max = 0;
    for (let i = 0; i < frames; i++)
      max = Math.max(max, Math.abs(wav.readIntLE(44 + i * 6, 3)));
    expect(max).toBeLessThan(8388607);
    expect(max).toBeGreaterThan(8388607 * 0.9);
  });

  it("rejects files that are not dsf", async () => {
    const source = path.join(dir, "x.dsf");
    await fs.writeFile(source, Buffer.alloc(200));
    await expect(
      convertDsfToWav(source, path.join(dir, "x.wav")),
    ).rejects.toThrow();
    await expect(fs.access(path.join(dir, "x.wav.part"))).rejects.toThrow();
  });
});
