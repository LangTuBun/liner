import fsp from "node:fs/promises";
import { setTimeout as yieldToLoop } from "node:timers/promises";
import { LoudnessMeter, type LoudnessMeasurement } from "./loudness.js";

export async function measureWav(
  filePath: string,
): Promise<LoudnessMeasurement> {
  const file = await fsp.open(filePath, "r");
  try {
    const size = (await file.stat()).size;
    const head = Buffer.alloc(12);
    await file.read(head, 0, 12, 0);
    if (
      head.toString("ascii", 0, 4) !== "RIFF" ||
      head.toString("ascii", 8) !== "WAVE"
    )
      throw new Error("Invalid WAV header");
    let channels = 0,
      rate = 0,
      bits = 0,
      align = 0;
    let dataStart = 0,
      dataSize = 0;
    const chunk = Buffer.alloc(8);
    for (let offset = 12; offset + 8 <= size;) {
      await file.read(chunk, 0, 8, offset);
      const name = chunk.toString("ascii", 0, 4);
      const length = chunk.readUInt32LE(4);
      if (offset + 8 + length > size) throw new Error("Truncated WAV");
      if (name === "fmt ") {
        if (length < 16) throw new Error("Invalid WAV format");
        const fmt = Buffer.alloc(Math.min(length, 40));
        await file.read(fmt, 0, fmt.length, offset + 8);
        const format = fmt.readUInt16LE(0);
        if (
          format !== 1 &&
          !(
            format === 0xfffe &&
            fmt.length === 40 &&
            fmt.readUInt16LE(24) === 1 &&
            fmt
              .subarray(26, 40)
              .equals(Buffer.from("000000001000800000aa00389b71", "hex"))
          )
        )
          throw new Error("Unsupported WAV encoding");
        channels = fmt.readUInt16LE(2);
        rate = fmt.readUInt32LE(4);
        align = fmt.readUInt16LE(12);
        bits = fmt.readUInt16LE(14);
      } else if (name === "data") {
        dataStart = offset + 8;
        dataSize = length;
      }
      offset += 8 + length + (length % 2);
    }
    if (
      !dataStart ||
      ![16, 24].includes(bits) ||
      ![1, 2].includes(channels) ||
      align !== (channels * bits) / 8 ||
      dataSize % align !== 0
    )
      throw new Error("Unsupported WAV format");
    const meter = new LoudnessMeter(rate, channels);
    // big chunks: every pause costs a timer tick, ~12 ms on Windows
    const buffer = Buffer.alloc(32768 * align);
    const divisor = 2 ** (bits - 1);
    for (let offset = 0; offset < dataSize;) {
      const count = Math.min(buffer.length, dataSize - offset);
      const { bytesRead } = await file.read(
        buffer,
        0,
        count,
        dataStart + offset,
      );
      if (bytesRead !== count) throw new Error("Truncated WAV samples");
      const planes = Array.from(
        { length: channels },
        () => new Float32Array(count / align),
      );
      for (let i = 0; i < count / align; i++)
        for (let c = 0; c < channels; c++)
          planes[c][i] =
            buffer.readIntLE(i * align + (c * bits) / 8, bits / 8) / divisor;
      meter.push(planes);
      offset += count;
      await yieldToLoop(1);
    }
    return meter.finish();
  } finally {
    await file.close();
  }
}
