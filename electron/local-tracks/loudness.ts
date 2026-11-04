export interface LoudnessMeasurement {
  // null represents silence or content below the absolute gate (JSON has no -Infinity).
  loudnessLufs: number | null;
  peakDb: number | null;
}

type Coefficients = [number, number, number, number, number];

function kWeighting(rate: number): [Coefficients, Coefficients] {
  const k = Math.tan((Math.PI * 1681.974450955533) / rate);
  const q = 0.7071752369554196;
  const vh = 10 ** (3.999843853973347 / 20);
  const vb = vh ** 0.4996667741545416;
  const a = 1 + k / q + k * k;
  const h = Math.tan((Math.PI * 38.13547087602444) / rate);
  const r = 0.5003270373238773;
  const d = 1 + h / r + h * h;
  return [
    [
      (vh + (vb * k) / q + k * k) / a,
      (2 * (k * k - vh)) / a,
      (vh - (vb * k) / q + k * k) / a,
      (2 * (k * k - 1)) / a,
      (1 - k / q + k * k) / a,
    ],
    [1, -2, 1, (2 * (h * h - 1)) / d, (1 - h / r + h * h) / d],
  ];
}

class Biquad {
  private z1 = 0;
  private z2 = 0;
  constructor(private readonly c: Coefficients) {}
  process(x: number): number {
    const [b0, b1, b2, a1, a2] = this.c;
    const y = b0 * x + this.z1;
    this.z1 = b1 * x - a1 * y + this.z2;
    this.z2 = b2 * x - a2 * y;
    return y;
  }
}

const toLufs = (power: number) => -0.691 + 10 * Math.log10(power);
const mean = (values: number[]) =>
  values.reduce((sum, v) => sum + v, 0) / values.length;

// BS.1770-4, mono/stereo: both channels have unit weight; they are summed, never averaged.
export class LoudnessMeter {
  private readonly filters: [Biquad, Biquad][];
  private readonly hop: number;
  private readonly powers: number[] = [];
  private readonly quarters: number[] = [];
  private frames = 0;
  private energy = 0;
  private peak = 0;

  constructor(sampleRate: number, channels: number) {
    if (
      !Number.isFinite(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 384000 ||
      (channels !== 1 && channels !== 2)
    )
      throw new Error("Unsupported loudness format");
    this.hop = Math.round(sampleRate / 10);
    const [shelf, highpass] = kWeighting(sampleRate);
    this.filters = Array.from({ length: channels }, () => [
      new Biquad(shelf),
      new Biquad(highpass),
    ]);
  }

  push(channels: readonly Float32Array[]): void {
    if (
      channels.length !== this.filters.length ||
      channels.some((c) => c.length !== channels[0].length)
    )
      throw new Error("Invalid loudness channels");
    for (let i = 0; i < channels[0].length; i++) {
      for (let c = 0; c < channels.length; c++) {
        const x = channels[c][i];
        if (!Number.isFinite(x)) throw new Error("Invalid audio sample");
        this.peak = Math.max(this.peak, Math.abs(x));
        const [shelf, highpass] = this.filters[c];
        const y = highpass.process(shelf.process(x));
        this.energy += y * y;
      }
      if (++this.frames === this.hop) {
        this.quarters.push(this.energy / this.hop);
        if (this.quarters.length > 4) this.quarters.shift();
        if (this.quarters.length === 4) this.powers.push(mean(this.quarters));
        this.frames = 0;
        this.energy = 0;
      }
    }
  }

  finish(): LoudnessMeasurement {
    const absolute = this.powers.filter((p) => toLufs(p) >= -70);
    const relative = toLufs(mean(absolute)) - 10;
    const gated = absolute.filter((p) => toLufs(p) >= relative);
    return {
      loudnessLufs: gated.length ? toLufs(mean(gated)) : null,
      peakDb: this.peak > 0 ? 20 * Math.log10(this.peak) : null,
    };
  }
}

export function volumeMatchDb(
  enabled: boolean,
  measurement?: Partial<LoudnessMeasurement> | null,
): number {
  const lufs = measurement?.loudnessLufs;
  const peak = measurement?.peakDb;
  if (
    !enabled ||
    typeof lufs !== "number" ||
    !Number.isFinite(lufs) ||
    typeof peak !== "number" ||
    !Number.isFinite(peak)
  )
    return 0;
  // If a decoded source exceeds +23 dBFS, no gain inside the allowed range is safe.
  if (peak > 23) return 0;
  return Math.max(-24, Math.min(12, -14 - lufs, -1 - peak));
}
