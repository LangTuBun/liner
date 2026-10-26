import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";
import { afterEach, beforeEach, expect, it } from "vitest";
import { embedFlacCover, hasFrontCover } from "./flacPicture";

let dir: string;

// a header-only flac: streaminfo for 48 kHz / 24-bit stereo, then stand-in frames
function flacBytes(frames: Buffer): Buffer {
  const info = Buffer.alloc(34);
  info.writeUInt16BE(4096, 0);
  info.writeUInt16BE(4096, 2);
  // sample rate (20 bits) | channels-1 (3) | bps-1 (5) | total samples (36)
  const packed = (BigInt(48000) << 44n) | (1n << 41n) | (23n << 36n) | 48000n;
  info.writeBigUInt64BE(packed, 10);
  const header = Buffer.from([0x80, 0, 0, 34]);
  return Buffer.concat([Buffer.from("fLaC"), header, info, frames]);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "liner-flac-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

it("embeds a front cover and keeps the audio frames byte for byte", async () => {
  const frames = Buffer.from([0xff, 0xf8, 1, 2, 3, 4, 5, 6, 7, 8]);
  const file = path.join(dir, "a.flac");
  await fs.writeFile(file, flacBytes(frames));
  const image = Buffer.from("not really a jpeg");

  await embedFlacCover(file, {
    data: image,
    mimeType: "image/jpeg",
    width: 3000,
    height: 3000,
  });
  // embedding again replaces the cover instead of stacking a second one
  await embedFlacCover(file, {
    data: image,
    mimeType: "image/jpeg",
    width: 3000,
    height: 3000,
  });

  const bytes = await fs.readFile(file);
  expect(bytes.subarray(bytes.length - frames.length)).toEqual(frames);
  expect(await hasFrontCover(file)).toBe(true);
  const { common, format } = await parseFile(file);
  expect(common.picture).toHaveLength(1);
  expect(common.picture?.[0].format).toBe("image/jpeg");
  expect(Buffer.from(common.picture![0].data)).toEqual(image);
  expect(format.sampleRate).toBe(48000);
  expect(format.bitsPerSample).toBe(24);
});

it("refuses files that are not flac", async () => {
  const file = path.join(dir, "b.flac");
  await fs.writeFile(file, "RIFF....WAVE");
  await expect(
    embedFlacCover(file, {
      data: Buffer.from("x"),
      mimeType: "image/png",
      width: 1,
      height: 1,
    }),
  ).rejects.toThrow("not a flac file");
});
