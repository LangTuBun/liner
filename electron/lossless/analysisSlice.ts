import fsp from "node:fs/promises";
import path from "node:path";
import { readMetadata } from "./flacPicture.js";

const SLICE_SECONDS = 25;
const MAX_SLICE_BYTES = 48 * 1024 * 1024;
const START_FRACTION = 0.3;

async function readRange(filePath: string, start: number, length: number) {
  const handle = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function sliceBounds(audioStart: number, size: number, durationSec: number) {
  const audioBytes = size - audioStart;
  const perSecond = durationSec > 0 ? audioBytes / durationSec : audioBytes;
  const length = Math.min(
    MAX_SLICE_BYTES,
    Math.round(perSecond * SLICE_SECONDS),
    audioBytes,
  );
  const start =
    audioStart +
    Math.max(0, Math.round((audioBytes - length) * START_FRACTION));
  return { start, length };
}

// flac: the metadata header followed by frames from the middle of the song. The
// decoder finds the next frame sync on its own
async function flacSlice(filePath: string, durationSec: number) {
  const { audioStart } = await readMetadata(filePath);
  const { size } = await fsp.stat(filePath);
  const { start, length } = sliceBounds(audioStart, size, durationSec);
  const [header, frames] = await Promise.all([
    readRange(filePath, 0, audioStart),
    readRange(filePath, start, length),
  ]);
  return Buffer.concat([header, frames]);
}

// wav: a fresh 44-byte header around a block-aligned run of samples
async function wavSlice(filePath: string, durationSec: number) {
  const head = await readRange(filePath, 0, 64 * 1024);
  if (
    head.toString("latin1", 0, 4) !== "RIFF" ||
    head.toString("latin1", 8, 12) !== "WAVE"
  )
    throw new Error("not a wav file");
  let offset = 12;
  let fmt: Buffer | null = null;
  let dataStart = 0;
  let dataSize = 0;
  while (offset + 8 <= head.length) {
    const id = head.toString("latin1", offset, offset + 4);
    const size = head.readUInt32LE(offset + 4);
    if (id === "fmt ") fmt = head.subarray(offset + 8, offset + 8 + size);
    if (id === "data") {
      dataStart = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !dataStart) throw new Error("wav chunks not found");
  const blockAlign = fmt.readUInt16LE(12);
  const { size: fileSize } = await fsp.stat(filePath);
  const end = Math.min(fileSize, dataStart + dataSize);
  const bounds = sliceBounds(dataStart, end, durationSec);
  const start =
    dataStart +
    Math.floor((bounds.start - dataStart) / blockAlign) * blockAlign;
  const length = Math.floor(bounds.length / blockAlign) * blockAlign;
  const samples = await readRange(filePath, start, length);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  fmt.copy(header, 20, 0, 16);
  // extensible headers become plain pcm / float so every decoder takes them
  if (header.readUInt16LE(20) === 0xfffe)
    header.writeUInt16LE(fmt.length >= 26 ? fmt.readUInt16LE(24) : 1, 20);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

export async function readAnalysisSlice(
  filePath: string,
  durationSec: number,
): Promise<Buffer> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".flac") return flacSlice(filePath, durationSec);
  if (ext === ".wav") return wavSlice(filePath, durationSec);
  throw new Error("unsupported format");
}
