import {
  classifyUltrasonic,
  type HiResVerdict,
} from "../../../../electron/lossless/query";

const FFT_SIZE = 8192;
const SKIP_SECONDS = 1;
const ANALYZE_SECONDS = 20;
export const BELOW_CD_NYQUIST: [number, number] = [17_000, 21_000];
export const ABOVE_CD_NYQUIST: [number, number] = [24_000, 30_000];
const ULTRASONIC_FROM = 30_000;
const ULTRASONIC_TO = 40_000;

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const next = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = next;
      }
    }
  }
}

// rms level in dBFS of the signal inside each band, from hann-windowed frames
// (a full-scale sine reads about -3 dBFS, like an rms meter)
export function bandLevelsDb(
  samples: Float32Array,
  sampleRate: number,
  bands: Array<[number, number]>,
): number[] {
  const window = new Float64Array(FFT_SIZE);
  let windowPower = 0;
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
    windowPower += window[i] * window[i];
  }
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const power = new Float64Array(FFT_SIZE / 2);
  let frames = 0;
  for (let start = 0; start + FFT_SIZE <= samples.length; start += FFT_SIZE) {
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < FFT_SIZE / 2; k++)
      power[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  const hzPerBin = sampleRate / FFT_SIZE;
  return bands.map(([lo, hi]) => {
    if (!frames || hi >= sampleRate / 2) return -Infinity;
    let sum = 0;
    for (let k = Math.ceil(lo / hzPerBin); k <= Math.floor(hi / hzPerBin); k++)
      sum += power[k];
    const meanSquare = (2 * sum) / (frames * FFT_SIZE * windowPower);
    return meanSquare > 0 ? 10 * Math.log10(meanSquare) : -Infinity;
  });
}

export function judgeHiRes(
  samples: Float32Array,
  sampleRate: number,
): {
  verdict: HiResVerdict;
  below: number;
  above: number;
  ultrasonic?: number;
} {
  const ultrasonicTo = Math.min(ULTRASONIC_TO, Math.floor(sampleRate * 0.475));
  const bands: Array<[number, number]> = [BELOW_CD_NYQUIST, ABOVE_CD_NYQUIST];
  if (ultrasonicTo > ULTRASONIC_FROM + 2_000)
    bands.push([ULTRASONIC_FROM, ultrasonicTo]);
  const [below, above, ultrasonic] = bandLevelsDb(samples, sampleRate, bands);
  return {
    verdict: classifyUltrasonic(below, above, ultrasonic),
    below,
    above,
    ultrasonic,
  };
}

// decodes a slice from the middle of the file at its own rate (no resampling,
// so content above 22 kHz survives) and looks for the cliff an upsample leaves
export async function checkHiRes(
  localId: string,
  sampleRate: number,
): Promise<HiResVerdict> {
  const bridge = window.linerElectron;
  if (!bridge?.losslessAnalysisSlice) return "unknown";
  const bytes = await bridge.losslessAnalysisSlice(localId);
  const context = new OfflineAudioContext(1, 1, sampleRate);
  const buffer = await context.decodeAudioData(
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  const from = Math.min(
    buffer.length,
    Math.round(SKIP_SECONDS * buffer.sampleRate),
  );
  const to = Math.min(
    buffer.length,
    from + Math.round(ANALYZE_SECONDS * buffer.sampleRate),
  );
  const mono = new Float32Array(to - from);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c).subarray(from, to);
    for (let i = 0; i < mono.length; i++)
      mono[i] += data[i] / buffer.numberOfChannels;
  }
  return judgeHiRes(mono, buffer.sampleRate).verdict;
}
