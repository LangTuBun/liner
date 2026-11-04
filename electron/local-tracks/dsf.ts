import fsp from "node:fs/promises";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { wavHeader } from "./wav.js";

// Chromium cannot play DSD, so a .dsf is decoded to 24-bit PCM on import.
// Output rate is the DSD rate / 32: DSD64 88.2 kHz, DSD128 176.4 kHz,
// DSD256 352.8 kHz, all 24-bit. shortcut: stereo or mono .dsf only, .dff is
// not read, upgrade when someone needs it.
const DECIMATION = 32;

const HEADER_BYTES = 92;
const STAGE1_BYTES = 32; // 256-tap table filter, decimates 8 input bits per output
const BLOCKS_PER_READ = 32;

export interface DsfConversion {
  frames: number;
  sampleRate: number;
  bitDepth: number;
}

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

// Kaiser-windowed sinc, unity gain at DC. cutoff is in cycles per sample.
function lowpass(taps: number, cutoff: number, beta = 9): Float64Array {
  const h = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const arg = 2 * Math.PI * cutoff * x;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(arg) / (Math.PI * x);
    const ratio = x / (mid || 1);
    const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - ratio * ratio)));
    h[i] = sinc * window;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

function stage1Table(lsbFirst: boolean): Float64Array {
  const h = lowpass(STAGE1_BYTES * 8, 0.3 / 8);
  const table = new Float64Array(STAGE1_BYTES * 256);
  for (let k = 0; k < STAGE1_BYTES; k++) {
    for (let b = 0; b < 256; b++) {
      let acc = 0;
      for (let i = 0; i < 8; i++) {
        const bit = lsbFirst ? (b >> i) & 1 : (b >> (7 - i)) & 1;
        acc += h[8 * k + 7 - i] * (bit ? 1 : -1);
      }
      table[k * 256 + b] = acc;
    }
  }
  return table;
}

class Channel {
  private bytes: Uint8Array;
  private pcm: Float64Array;
  private next: number;
  private readonly history: number;

  constructor(
    private readonly table: Float64Array,
    private readonly fir: Float64Array,
    private readonly step: number,
    private readonly capacity: number,
  ) {
    // 0x69 is the DSD idle pattern, so the filter starts on silence
    this.bytes = new Uint8Array(STAGE1_BYTES - 1 + capacity).fill(0x69);
    this.history = fir.length - 1;
    this.pcm = new Float64Array(this.history + capacity);
    this.next = this.history;
  }

  // Consumes `count` DSD bytes, appends finished samples to `out`.
  push(input: Uint8Array, count: number, out: number[]) {
    const { bytes, pcm, table, fir, history, step } = this;
    bytes.set(input.subarray(0, count), STAGE1_BYTES - 1);
    for (let j = 0; j < count; j++) {
      let acc = 0;
      for (let k = 0; k < STAGE1_BYTES; k++)
        acc += table[k * 256 + bytes[j + STAGE1_BYTES - 1 - k]];
      pcm[history + j] = acc;
    }
    const end = history + count;
    let e = this.next;
    while (e < end) {
      let acc = 0;
      const start = e - history;
      for (let k = 0; k < fir.length; k++) acc += fir[k] * pcm[start + k];
      out.push(acc);
      e += step;
    }
    this.next = e - count;
    pcm.copyWithin(0, count, count + history);
    bytes.copyWithin(0, count, count + STAGE1_BYTES - 1);
  }
}

// DSD can swing past full scale. Decode once; if it clipped, decode again
// with the gain that puts the loudest sample just under it.
export async function convertDsfToWav(
  source: string,
  dest: string,
): Promise<DsfConversion> {
  const first = await decode(source, dest, 1);
  if (first.peak <= HEADROOM) return first;
  return decode(source, dest, HEADROOM / first.peak);
}

const HEADROOM = 0.999;

async function decode(
  source: string,
  dest: string,
  gain: number,
): Promise<DsfConversion & { peak: number }> {
  const input = await fsp.open(source, "r");
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await input.read(head, 0, HEADER_BYTES, 0);
    if (
      bytesRead < HEADER_BYTES ||
      head.toString("latin1", 0, 4) !== "DSD " ||
      head.toString("latin1", 28, 32) !== "fmt " ||
      head.toString("latin1", 80, 84) !== "data"
    )
      throw new Error("not a dsf file");
    const formatId = head.readUInt32LE(44);
    const channels = head.readUInt32LE(52);
    const rate = head.readUInt32LE(56);
    const lsbFirst = head.readUInt32LE(60) === 1;
    const sampleCount = Number(head.readBigUInt64LE(64));
    const blockSize = head.readUInt32LE(72);
    if (formatId !== 0 || channels < 1 || channels > 2 || blockSize === 0)
      throw new Error("unsupported dsf layout");
    const outRate = rate / DECIMATION;
    if (!Number.isInteger(outRate) || rate < 2_822_400)
      throw new Error("unsupported dsd rate");
    const step = DECIMATION / 8;

    const table = stage1Table(lsbFirst);
    const fir = lowpass(64 * step - 1, 0.45 / step);
    const lanes = Array.from(
      { length: channels },
      () => new Channel(table, fir, step, blockSize),
    );

    const bytesPerChannel = Math.ceil(sampleCount / 8);
    const blocks = Math.ceil(bytesPerChannel / blockSize);
    const temp = `${dest}.part`;
    const output = await fsp.open(temp, "w");
    let frames = 0;
    let peak = 0;
    try {
      await output.write(wavHeader(0, channels, outRate, 24), 0, 44, 0);
      const chunk = Buffer.alloc(blockSize * channels * BLOCKS_PER_READ);
      const lane: number[][] = lanes.map(() => []);
      for (let first = 0; first < blocks; first += BLOCKS_PER_READ) {
        const count = Math.min(BLOCKS_PER_READ, blocks - first);
        const length = count * blockSize * channels;
        const offset = HEADER_BYTES + first * blockSize * channels;
        const read = await input.read(chunk, 0, length, offset);
        if (read.bytesRead < length) chunk.fill(0x69, read.bytesRead, length);
        for (let b = 0; b < count; b++) {
          const valid = Math.min(
            blockSize,
            bytesPerChannel - (first + b) * blockSize,
          );
          for (let c = 0; c < channels; c++) {
            const at = (b * channels + c) * blockSize;
            lanes[c].push(chunk.subarray(at, at + blockSize), valid, lane[c]);
          }
        }
        const ready = lane[0].length;
        const pcm = Buffer.alloc(ready * channels * 3);
        for (let i = 0; i < ready; i++) {
          for (let c = 0; c < channels; c++) {
            const x = lane[c][i];
            if (Math.abs(x) > peak) peak = Math.abs(x);
            const v = Math.max(
              -8388608,
              Math.min(8388607, Math.round(x * gain * 8388607)),
            );
            pcm.writeIntLE(v, (i * channels + c) * 3, 3);
          }
        }
        for (const samples of lane) samples.length = 0;
        await output.write(pcm, 0, pcm.length, 44 + frames * channels * 3);
        frames += ready;
        await yieldToLoop(); // keep the main process responsive
      }
      await output.write(wavHeader(frames, channels, outRate, 24), 0, 44, 0);
    } catch (error) {
      await output.close();
      await fsp.rm(temp, { force: true });
      throw error;
    }
    await output.close();
    await fsp.rename(temp, dest);
    return { frames, sampleRate: outRate, bitDepth: 24, peak };
  } finally {
    await input.close();
  }
}
