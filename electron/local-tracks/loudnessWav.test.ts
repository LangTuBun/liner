import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { measureWav } from "./loudnessWav";
import { wavHeader } from "./wav";

describe("streaming PCM loudness reader", () => {
  let root: string;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "liner-loudness-"));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it.each([16, 24] as const)(
    "measures %s-bit 176.4 kHz PCM across read boundaries and leaves the file intact",
    async (bits) => {
      const rate = 176400;
      const data = Buffer.alloc((rate * 2 * bits) / 8);
      for (let i = 0; i < rate; i++) {
        const x = Math.round(
          10 ** (-23 / 20) *
            Math.sin((2 * Math.PI * 997 * i) / rate) *
            2 ** (bits - 1),
        );
        for (let c = 0; c < 2; c++)
          data.writeIntLE(x, ((i * 2 + c) * bits) / 8, bits / 8);
      }
      const bytes = Buffer.concat([wavHeader(rate, 2, rate, bits), data]);
      const file = path.join(root, "tone.wav");
      await fsp.writeFile(file, bytes);
      const measurement = await measureWav(file);
      expect(Math.abs(measurement.loudnessLufs! + 23)).toBeLessThan(0.1);
      expect(measurement.peakDb).toBeCloseTo(-23, 2);
      expect(await fsp.readFile(file)).toEqual(bytes);
    },
  );

  it("rejects truncated files, non-PCM encoding, and invalid block alignment", async () => {
    const file = path.join(root, "bad.wav");
    const header = wavHeader(100, 2, 48000, 16);
    await fsp.writeFile(file, header);
    await expect(measureWav(file)).rejects.toThrow("Truncated");
    const bytes = Buffer.concat([header, Buffer.alloc(400)]);
    bytes.writeUInt16LE(3, 20);
    await fsp.writeFile(file, bytes);
    await expect(measureWav(file)).rejects.toThrow("encoding");
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(3, 32);
    await fsp.writeFile(file, bytes);
    await expect(measureWav(file)).rejects.toThrow("format");
  });
});
