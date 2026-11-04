import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertAlacToWav } from "./alac";

// tone.alac.m4a is this signal encoded as Apple Lossless (by mpv/ffmpeg), so
// a correct decoder returns exactly these samples. The encoder pads the end
// with silence up to six whole 4096-frame blocks, and the file says so.
const RATE = 44100;
const FRAMES = 22050 + 123;
const PADDED = 6 * 4096;

function expectedPcm(): Buffer {
  const pcm = Buffer.alloc(FRAMES * 4);
  let seed = 12345;
  const rnd = () =>
    ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < FRAMES; i++) {
    pcm.writeInt16LE(
      Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / RATE) + 600 * rnd()),
      i * 4,
    );
    pcm.writeInt16LE(
      Math.round(7000 * Math.sin((2 * Math.PI * 660 * i) / RATE) + 600 * rnd()),
      i * 4 + 2,
    );
  }
  return pcm;
}

describe("convertAlacToWav", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "liner-alac-"));
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it("decodes Apple Lossless to the exact samples it was made from", async () => {
    const dest = path.join(dir, "tone.wav");
    const result = await convertAlacToWav(
      path.join(__dirname, "fixtures", "tone.alac.m4a"),
      dest,
    );
    const wav = await fs.readFile(dest);

    expect(result).toEqual({ frames: PADDED, sampleRate: RATE, bitDepth: 16 });
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(24)).toBe(RATE);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(PADDED * 4);
    expect(wav.subarray(44, 44 + FRAMES * 4).equals(expectedPcm())).toBe(true);
    expect(wav.subarray(44 + FRAMES * 4).every((byte) => byte === 0)).toBe(
      true,
    );
  });

  it("rejects a file that is not an m4a and leaves nothing behind", async () => {
    const source = path.join(dir, "x.m4a");
    await fs.writeFile(source, Buffer.alloc(64));
    await expect(
      convertAlacToWav(source, path.join(dir, "x.wav")),
    ).rejects.toThrow();
    await expect(fs.access(path.join(dir, "x.wav.part"))).rejects.toThrow();
  });
});
