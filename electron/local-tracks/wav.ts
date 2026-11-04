// 44-byte PCM WAV header; the data size is known once decoding has finished
export function wavHeader(
  frames: number,
  channels: number,
  rate: number,
  bits: 16 | 24,
): Buffer {
  const blockAlign = channels * (bits / 8);
  const dataBytes = frames * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
