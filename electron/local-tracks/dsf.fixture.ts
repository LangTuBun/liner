const RATE = 5_644_800; // DSD128
const SECONDS = 0.2;
const BLOCK = 4096;

// first-order sigma-delta, LSB first, like a real .dsf
function modulate(bytes: number, signal: (n: number) => number): Buffer {
  const out = Buffer.alloc(bytes);
  let integrator = 0;
  let last = 1;
  for (let n = 0; n < bytes * 8; n++) {
    integrator += signal(n) - last;
    last = integrator >= 0 ? 1 : -1;
    if (last === 1) out[n >> 3] |= 1 << (n & 7);
  }
  return out;
}

function dsf(left: Buffer, right?: Buffer): Buffer {
  const blocks = Math.ceil(left.length / BLOCK);
  const channels = right ? 2 : 1;
  const head = Buffer.alloc(92);
  head.write("DSD ", 0);
  head.writeBigUInt64LE(28n, 4);
  head.write("fmt ", 28);
  head.writeBigUInt64LE(52n, 32);
  head.writeUInt32LE(1, 40);
  head.writeUInt32LE(channels, 48);
  head.writeUInt32LE(channels, 52);
  head.writeUInt32LE(RATE, 56);
  head.writeUInt32LE(1, 60);
  head.writeBigUInt64LE(BigInt(left.length * 8), 64);
  head.writeUInt32LE(BLOCK, 72);
  head.write("data", 80);
  const body = Buffer.alloc(blocks * BLOCK * channels, 0x69);
  for (let b = 0; b < blocks; b++) {
    left.copy(body, b * BLOCK * channels, b * BLOCK, (b + 1) * BLOCK);
    right?.copy(body, b * BLOCK * channels + BLOCK, b * BLOCK, (b + 1) * BLOCK);
  }
  return Buffer.concat([head, body]);
}

export { RATE, SECONDS, dsf, modulate };
