import fsp from "node:fs/promises";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { wavHeader } from "./wav.js";

// Chromium has no Apple Lossless decoder, so an ALAC .m4a is decoded to a WAV
// of the same samples on import. The frame decoder is a port of audiocogs'
// alac.js (Apache-2.0) with a small MP4 reader around it.
// shortcut: 16 and 24-bit mono or stereo only (20 and 32-bit are rare);
// upgrade when such a file turns up.

export interface AlacConversion {
  frames: number;
  sampleRate: number;
  bitDepth: number;
}

const ID_SCE = 0;
const ID_CPE = 1;
const ID_CCE = 2;
const ID_LFE = 3;
const ID_DSE = 4;
const ID_PCE = 5;
const ID_FIL = 6;
const ID_END = 7;

const QBSHIFT = 9;
const QB = 1 << QBSHIFT;
const MMULSHIFT = 2;
const MDENSHIFT = QBSHIFT - MMULSHIFT - 1;
const MOFF = 1 << (MDENSHIFT - 2);
const MAX_PREFIX = 9;
const MAX_DATATYPE_BITS_16 = 16;
const N_MAX_MEAN_CLAMP = 0xffff;
const BITOFF = 24;

class BitReader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get length() {
    return this.bytes.length * 8;
  }

  private byte(index: number) {
    return index < this.bytes.length ? this.bytes[index] : 0;
  }

  // the next 32 bits as an int32; bits past the end read as zero
  peek32(): number {
    const at = this.pos >>> 3;
    const off = this.pos & 7;
    const hi =
      (this.byte(at) << 24) |
      (this.byte(at + 1) << 16) |
      (this.byte(at + 2) << 8) |
      this.byte(at + 3);
    return off === 0 ? hi : (hi << off) | (this.byte(at + 4) >>> (8 - off));
  }

  read(bits: number): number {
    if (bits === 0) return 0;
    const value = this.peek32() >>> (32 - bits);
    this.pos += bits;
    return value;
  }

  advance(bits: number) {
    this.pos += bits;
  }

  copy(): BitReader {
    const clone = new BitReader(this.bytes);
    clone.pos = this.pos;
    return clone;
  }

  align() {
    this.pos = (this.pos + 7) & ~7;
  }
}

function dynGet16(data: BitReader, m: number, k: number): number {
  let stream = data.peek32();
  const prefix = Math.clz32(~stream);
  if (prefix >= MAX_PREFIX) {
    data.advance(MAX_PREFIX + MAX_DATATYPE_BITS_16);
    stream <<= MAX_PREFIX;
    return stream >>> (32 - MAX_DATATYPE_BITS_16);
  }
  data.advance(prefix + k);
  stream <<= prefix + 1;
  const v = stream >>> (32 - k);
  let result = prefix * m + v - 1;
  if (v < 2) result -= v - 1;
  else data.advance(1);
  return result;
}

function dynGet32(data: BitReader, m: number, k: number, maxBits: number) {
  let stream = data.peek32();
  let result = Math.clz32(~stream);
  if (result >= MAX_PREFIX) {
    data.advance(MAX_PREFIX);
    return data.read(maxBits);
  }
  data.advance(result + 1);
  if (k !== 1) {
    stream <<= result + 1;
    result *= m;
    const v = stream >>> (32 - k);
    data.advance(k - 1);
    if (v > 1) {
      result += v - 1;
      data.advance(1);
    }
  }
  return result;
}

// adaptive Golomb-Rice decoding of one channel's residuals
function dynDecomp(
  mb0: number,
  pb: number,
  kb: number,
  data: BitReader,
  pc: Int32Array,
  samples: number,
  maxBits: number,
): boolean {
  const wb = (1 << kb) - 1;
  let mb = mb0;
  let zmode = 0;
  let c = 0;
  while (c < samples) {
    let m = mb >>> QBSHIFT;
    let k = Math.min(31 - Math.clz32(m + 3), kb);
    m = (1 << k) - 1;
    let n = dynGet32(data, m, k, maxBits);
    const ndecode = n + zmode;
    const multiplier = -(ndecode & 1) | 1;
    pc[c++] = ((ndecode + 1) >>> 1) * multiplier;
    mb = pb * (n + zmode) + mb - ((pb * mb) >> QBSHIFT);
    if (n > N_MAX_MEAN_CLAMP) mb = N_MAX_MEAN_CLAMP;
    zmode = 0;
    if (mb << MMULSHIFT < QB && c < samples) {
      zmode = 1;
      k = Math.clz32(mb) - BITOFF + ((mb + MOFF) >> MDENSHIFT);
      const mz = ((1 << k) - 1) & wb;
      n = dynGet16(data, mz, k);
      if (c + n > samples) return false;
      for (let j = 0; j < n; j++) pc[c++] = 0;
      if (n >= 65535) zmode = 0;
      mb = 0;
    }
  }
  return true;
}

const sign = (value: number) => (-value >>> 31) | (value >> 31);

// undoes the adaptive linear prediction; `coefs` adapt as they go
function unpcBlock(
  pc1: Int32Array,
  out: Int32Array,
  num: number,
  coefs: Int16Array | null,
  active: number,
  chanBits: number,
  denShift: number,
) {
  const chanShift = 32 - chanBits;
  const denHalf = 1 << (denShift - 1);
  out[0] = pc1[0];
  if (active === 0) {
    out.set(pc1.subarray(0, num));
    return;
  }
  if (active === 31) {
    let prev = out[0];
    for (let i = 1; i < num; i++) {
      prev = ((pc1[i] + prev) << chanShift) >> chanShift;
      out[i] = prev;
    }
    return;
  }
  const warm = Math.min(active, num - 1);
  for (let i = 1; i <= warm; i++)
    out[i] = ((pc1[i] + out[i - 1]) << chanShift) >> chanShift;
  const lim = active + 1;
  for (let i = lim; i < num; i++) {
    let sum = 0;
    const top = out[i - lim];
    const offset = i - 1;
    for (let j = 0; j < active; j++) sum += coefs![j] * (out[offset - j] - top);
    let del = pc1[i];
    let del0 = del;
    const sg = sign(del);
    del += top + ((sum + denHalf) >> denShift);
    out[i] = (del << chanShift) >> chanShift;
    if (sg > 0) {
      for (let j = active - 1; j >= 0; j--) {
        const dd = top - out[offset - j];
        const sgn = sign(dd);
        coefs![j] -= sgn;
        del0 -= (active - j) * ((sgn * dd) >> denShift);
        if (del0 <= 0) break;
      }
    } else if (sg < 0) {
      for (let j = active - 1; j >= 0; j--) {
        const dd = top - out[offset - j];
        const sgn = sign(dd);
        coefs![j] += sgn;
        del0 -= (active - j) * ((-sgn * dd) >> denShift);
        if (del0 >= 0) break;
      }
    }
  }
}

// Stereo back from mid/side. A 24-bit sample is stored as its top 16 bits
// predicted plus its low byte kept apart in `low`.
function unmix(
  u: Int32Array,
  v: Int32Array,
  out: Int32Array,
  stride: number,
  first: number,
  samples: number,
  mixBits: number,
  mixRes: number,
  shift: number,
  low: Uint16Array,
) {
  for (let i = 0; i < samples; i++) {
    let l = u[i];
    let r = v[i];
    if (mixRes !== 0) {
      l = u[i] + v[i] - ((mixRes * v[i]) >> mixBits);
      r = l - v[i];
    }
    if (shift) {
      l = (l << shift) | low[i * 2];
      r = (r << shift) | low[i * 2 + 1];
    }
    out[i * stride + first] = l;
    out[i * stride + first + 1] = r;
  }
}

interface AlacConfig {
  frameLength: number;
  bitDepth: number;
  pb: number;
  mb: number;
  kb: number;
  numChannels: number;
  sampleRate: number;
}

interface Work {
  mix: [Int32Array, Int32Array];
  predictor: Int32Array;
  low: Uint16Array;
}

// one ALAC frame into `out` (interleaved); returns how many sample frames
function decodeFrame(
  data: BitReader,
  cfg: AlacConfig,
  work: Work,
  out: Int32Array,
): number {
  let samples = cfg.frameLength;
  let channelIndex = 0;
  for (;;) {
    const tag = data.read(3);
    if (tag === ID_END) {
      data.align();
      return samples;
    }
    if (tag === ID_SCE || tag === ID_LFE || tag === ID_CPE) {
      const channels = tag === ID_CPE ? 2 : 1;
      if (channelIndex + channels > cfg.numChannels)
        throw new Error("too many channels");
      data.read(4);
      if (data.read(12) !== 0) throw new Error("bad element header");
      const partial = data.read(1);
      const bytesShifted = data.read(2);
      const escape = data.read(1);
      if (partial) samples = data.read(32);
      if (samples > cfg.frameLength) throw new Error("bad frame length");

      const shift = bytesShifted * 8;
      let mixBits = 0;
      let mixRes = 0;
      let shiftBits: BitReader | null = null;
      if (escape === 0) {
        const chanBits = cfg.bitDepth - shift + channels - 1;
        mixBits = data.read(8);
        mixRes = (data.read(8) << 24) >> 24;
        const mode: number[] = [];
        const denShift: number[] = [];
        const pbFactor: number[] = [];
        const num: number[] = [];
        const coefs: Int16Array[] = [];
        for (let ch = 0; ch < channels; ch++) {
          mode[ch] = data.read(4);
          denShift[ch] = data.read(4);
          pbFactor[ch] = data.read(3);
          num[ch] = data.read(5);
          const table = (coefs[ch] = new Int16Array(32));
          for (let i = 0; i < num[ch]; i++) table[i] = data.read(16);
        }
        if (shift) {
          shiftBits = data.copy();
          data.advance(shift * channels * samples);
        }
        for (let ch = 0; ch < channels; ch++) {
          const pb = (cfg.pb * pbFactor[ch]) / 4;
          if (
            !dynDecomp(
              cfg.mb,
              pb,
              cfg.kb,
              data,
              work.predictor,
              samples,
              chanBits,
            )
          )
            throw new Error("bad residuals");
          if (mode[ch] !== 0)
            unpcBlock(
              work.predictor,
              work.predictor,
              samples,
              null,
              31,
              chanBits,
              0,
            );
          unpcBlock(
            work.predictor,
            work.mix[ch],
            samples,
            coefs[ch],
            num[ch],
            chanBits,
            denShift[ch],
          );
        }
      } else {
        const widen = 32 - cfg.bitDepth;
        for (let i = 0; i < samples; i++)
          for (let ch = 0; ch < channels; ch++)
            work.mix[ch][i] = (data.read(cfg.bitDepth) << widen) >> widen;
      }
      if (shiftBits && shift)
        for (let i = 0; i < samples * channels; i++)
          work.low[i] = shiftBits.read(shift);

      const applied = escape === 0 ? shift : 0;
      if (channels === 2)
        unmix(
          work.mix[0],
          work.mix[1],
          out,
          cfg.numChannels,
          channelIndex,
          samples,
          mixBits,
          mixRes,
          applied,
          work.low,
        );
      else
        for (let i = 0; i < samples; i++)
          out[i * cfg.numChannels + channelIndex] = applied
            ? (work.mix[0][i] << applied) | work.low[i]
            : work.mix[0][i];
      channelIndex += channels;
    } else if (tag === ID_DSE) {
      data.read(4);
      const align = data.read(1);
      let count = data.read(8);
      if (count === 255) count += data.read(8);
      if (align) data.align();
      data.advance(count * 8);
      if (data.pos >= data.length) throw new Error("buffer overrun");
    } else if (tag === ID_FIL) {
      let count = data.read(4);
      if (count === 15) count += data.read(8) - 1;
      data.advance(count * 8);
      if (data.pos >= data.length) throw new Error("buffer overrun");
    } else if (tag === ID_CCE || tag === ID_PCE) {
      throw new Error("unsupported ALAC element");
    }
  }
}

// ---- the MP4 container: find the ALAC settings and where each frame sits

interface Box {
  type: string;
  body: number;
  end: number;
}

function boxes(file: Buffer, from: number, to: number): Box[] {
  const found: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = file.readUInt32BE(at);
    let body = at + 8;
    if (size === 1) {
      size = Number(file.readBigUInt64BE(at + 8));
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < body - at || at + size > to) break;
    found.push({
      type: file.toString("latin1", at + 4, at + 8),
      body,
      end: at + size,
    });
    at += size;
  }
  return found;
}

const inside = (file: Buffer, box: Box | undefined, type: string) =>
  box ? boxes(file, box.body, box.end).find((b) => b.type === type) : undefined;

function readAlacTrack(file: Buffer): {
  cfg: AlacConfig;
  frames: { offset: number; size: number }[];
  // what plays: skip `start` samples, then `duration` of them; an encoder can
  // pad the blocks past the real length
  start: number;
  duration: number;
} {
  const moov = boxes(file, 0, file.length).find((b) => b.type === "moov");
  for (const trak of boxes(file, moov?.body ?? 0, moov?.end ?? 0)) {
    if (trak.type !== "trak") continue;
    const mdia = inside(file, trak, "mdia");
    const stbl = inside(file, inside(file, mdia, "minf"), "stbl");
    const stsd = inside(file, stbl, "stsd");
    if (!stbl || !stsd) continue;
    // sample description: version/flags, entry count, then the entries
    const entry = boxes(file, stsd.body + 8, stsd.end)[0];
    if (entry?.type !== "alac") continue;
    const settings = boxes(file, entry.body + 28, entry.end).find(
      (b) => b.type === "alac",
    );
    if (!settings) throw new Error("ALAC settings missing");
    const c = settings.body + 4;
    const cfg: AlacConfig = {
      frameLength: file.readUInt32BE(c),
      bitDepth: file.readUInt8(c + 5),
      pb: file.readUInt8(c + 6),
      mb: file.readUInt8(c + 7),
      kb: file.readUInt8(c + 8),
      numChannels: file.readUInt8(c + 9),
      sampleRate: file.readUInt32BE(c + 20),
    };

    const table = (type: string) => inside(file, { ...stbl, type: "" }, type);
    const stsz = table("stsz");
    const stsc = table("stsc");
    const stco = table("stco");
    const co64 = table("co64");
    if (!stsz || !stsc || (!stco && !co64)) throw new Error("no sample table");

    const fixed = file.readUInt32BE(stsz.body + 4);
    const count = file.readUInt32BE(stsz.body + 8);
    const sizeOf = (i: number) =>
      fixed || file.readUInt32BE(stsz.body + 12 + i * 4);
    const runs = file.readUInt32BE(stsc.body + 4);
    const chunkCount = file.readUInt32BE((stco ?? co64)!.body + 4);
    const chunkOffset = (i: number) =>
      stco
        ? file.readUInt32BE(stco.body + 8 + i * 4)
        : Number(file.readBigUInt64BE(co64!.body + 8 + i * 8));

    const frames: { offset: number; size: number }[] = [];
    let sample = 0;
    for (let r = 0; r < runs; r++) {
      const first = file.readUInt32BE(stsc.body + 8 + r * 12);
      const perChunk = file.readUInt32BE(stsc.body + 12 + r * 12);
      const last =
        r + 1 < runs
          ? file.readUInt32BE(stsc.body + 8 + (r + 1) * 12) - 1
          : chunkCount;
      for (let chunk = first; chunk <= last; chunk++) {
        let offset = chunkOffset(chunk - 1);
        for (let s = 0; s < perChunk && sample < count; s++, sample++) {
          const size = sizeOf(sample);
          frames.push({ offset, size });
          offset += size;
        }
      }
    }
    const stts = table("stts");
    let duration = Infinity;
    if (stts) {
      let total = 0;
      const entries = file.readUInt32BE(stts.body + 4);
      for (let i = 0; i < entries; i++)
        total +=
          file.readUInt32BE(stts.body + 8 + i * 8) *
          file.readUInt32BE(stts.body + 12 + i * 8);
      if (total > 0) duration = total;
    }
    // an edit list (ffmpeg writes one) says which part of the media plays
    let start = 0;
    const elst = inside(file, inside(file, trak, "edts"), "elst");
    const mvhd = boxes(file, moov!.body, moov!.end).find(
      (b) => b.type === "mvhd",
    );
    if (elst && mvhd) {
      const v1 = file.readUInt8(mvhd.body) === 1;
      const movieScale = file.readUInt32BE(mvhd.body + (v1 ? 20 : 12));
      const wide = file.readUInt8(elst.body) === 1;
      const entries = file.readUInt32BE(elst.body + 4);
      for (
        let i = 0, at = elst.body + 8;
        i < entries;
        i++, at += wide ? 20 : 12
      ) {
        const segment = wide
          ? Number(file.readBigUInt64BE(at))
          : file.readUInt32BE(at);
        const mediaTime = wide
          ? Number(file.readBigInt64BE(at + 8))
          : file.readInt32BE(at + 4);
        if (mediaTime < 0 || !movieScale) continue;
        start = mediaTime;
        duration = Math.min(
          duration,
          Math.round((segment / movieScale) * cfg.sampleRate),
        );
        break;
      }
    }
    return { cfg, frames, start, duration };
  }
  throw new Error("no ALAC track");
}

// what the ALAC settings in the file say; null when it is not Apple Lossless.
// The tag reader reports 16 bits for a 24-bit file, so this is the source of
// truth for bit depth and rate.
export async function alacFormat(
  source: string,
): Promise<{ bitDepth: number; sampleRate: number } | null> {
  try {
    const { cfg } = readAlacTrack(await fsp.readFile(source));
    return { bitDepth: cfg.bitDepth, sampleRate: cfg.sampleRate };
  } catch {
    return null;
  }
}

const FLUSH_FRAMES = 64;

export async function convertAlacToWav(
  source: string,
  dest: string,
): Promise<AlacConversion> {
  const file = await fsp.readFile(source);
  const { cfg, frames, start, duration } = readAlacTrack(file);
  if (
    (cfg.bitDepth !== 16 && cfg.bitDepth !== 24) ||
    cfg.numChannels < 1 ||
    cfg.numChannels > 2 ||
    cfg.frameLength < 1 ||
    cfg.frameLength > 1 << 16
  )
    throw new Error(`unsupported ALAC layout ${JSON.stringify(cfg)}`);

  const work: Work = {
    mix: [new Int32Array(cfg.frameLength), new Int32Array(cfg.frameLength)],
    predictor: new Int32Array(cfg.frameLength),
    low: new Uint16Array(cfg.frameLength * cfg.numChannels),
  };
  const bytesEach = cfg.bitDepth / 8;
  const block = new Int32Array(cfg.frameLength * cfg.numChannels);
  const pending = Buffer.alloc(block.length * bytesEach * FLUSH_FRAMES);

  const bits = cfg.bitDepth === 24 ? 24 : 16;
  const temp = `${dest}.part`;
  const output = await fsp.open(temp, "w");
  let decoded = 0;
  let skip = start;
  try {
    await output.write(
      wavHeader(0, cfg.numChannels, cfg.sampleRate, bits),
      0,
      44,
      0,
    );
    let filled = 0; // bytes waiting in `pending`
    const flush = async () => {
      if (filled === 0) return;
      await output.write(
        pending,
        0,
        filled,
        44 + decoded * cfg.numChannels * bytesEach - filled,
      );
      filled = 0;
    };
    for (let i = 0; i < frames.length; i++) {
      const { offset, size } = frames[i];
      const samples = decodeFrame(
        new BitReader(file.subarray(offset, offset + size)),
        cfg,
        work,
        block,
      );
      const from = Math.min(skip, samples);
      skip -= from;
      const take = Math.min(samples - from, duration - decoded);
      const first = from * cfg.numChannels;
      for (let n = 0; n < take * cfg.numChannels; n++) {
        const value = block[first + n];
        for (let b = 0; b < bytesEach; b++)
          pending[filled++] = (value >> (b * 8)) & 0xff;
      }
      decoded += take;
      if (decoded >= duration) break;
      if ((i + 1) % FLUSH_FRAMES === 0) {
        await flush();
        await yieldToLoop(); // keep the main process responsive
      }
    }
    await flush();
    await output.write(
      wavHeader(decoded, cfg.numChannels, cfg.sampleRate, bits),
      0,
      44,
      0,
    );
  } catch (error) {
    await output.close();
    await fsp.rm(temp, { force: true });
    throw error;
  }
  await output.close();
  await fsp.rename(temp, dest);
  return {
    frames: decoded,
    sampleRate: cfg.sampleRate,
    bitDepth: cfg.bitDepth,
  };
}
