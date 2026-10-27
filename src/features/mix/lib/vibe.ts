import { fft } from "@/features/lossless/lib/hiresCheck";

// What a song sounds like, from a slice of the audio itself: how loud, how
// bright and how fast. Enough to tell a late-night ballad from a car song.
export interface Vibe {
  // rms level in dBFS
  energy: number;
  // mean spectral centroid in Hz
  brightness: number;
  // beats per minute, folded into 70-160
  tempo: number;
  // 0-1: how clear the beat is; a loose acoustic song reads low
  pulse: number;
}

const FRAME = 1024;
const HOP = 256;
const TEMPO_FROM = 50;
const TEMPO_TO = 200;
const FOLD_LOW = 70;
const FOLD_HIGH = 160;

export function extractVibe(samples: Float32Array, sampleRate: number): Vibe {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const meanSquare = samples.length ? sum / samples.length : 0;
  const energy = meanSquare > 0 ? 10 * Math.log10(meanSquare) : -120;

  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++)
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const half = FRAME / 2;
  const hz = sampleRate / FRAME;
  let previous = new Float64Array(half);
  let magnitude = new Float64Array(half);
  const flux: number[] = [];
  let centroidSum = 0;
  let centroidFrames = 0;
  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    for (let i = 0; i < FRAME; i++) {
      re[i] = samples[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let total = 0;
    let weighted = 0;
    let rise = 0;
    for (let k = 1; k < half; k++) {
      magnitude[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      total += magnitude[k];
      weighted += magnitude[k] * k * hz;
      const diff = Math.sqrt(magnitude[k]) - Math.sqrt(previous[k]);
      if (diff > 0) rise += diff;
    }
    if (total > 1e-6) {
      centroidSum += weighted / total;
      centroidFrames += 1;
    }
    flux.push(rise);
    [previous, magnitude] = [magnitude, previous];
  }
  const brightness = centroidFrames ? centroidSum / centroidFrames : 0;

  // the beat is the lag at which the onset envelope best repeats itself
  const fps = sampleRate / HOP;
  const mean = flux.reduce((a, b) => a + b, 0) / (flux.length || 1);
  const env = flux.map((v) => v - mean);
  const zero = env.reduce((a, v) => a + v * v, 0);
  let bestLag = 0;
  let bestValue = 0;
  const lagMin = Math.max(1, Math.floor((60 / TEMPO_TO) * fps));
  const lagMax = Math.min(env.length - 1, Math.ceil((60 / TEMPO_FROM) * fps));
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let r = 0;
    for (let i = lag; i < env.length; i++) r += env[i] * env[i - lag];
    r /= env.length - lag;
    if (r > bestValue) {
      bestValue = r;
      bestLag = lag;
    }
  }
  let tempo = bestLag ? (60 * fps) / bestLag : 100;
  while (tempo < FOLD_LOW) tempo *= 2;
  while (tempo >= FOLD_HIGH) tempo /= 2;
  const pulse =
    zero > 0 && env.length > 0
      ? Math.max(0, Math.min(1, bestValue / (zero / env.length)))
      : 0;
  return { energy, brightness, tempo, pulse };
}

export async function analyzeLocalTrack(fileId: string): Promise<Vibe> {
  const bridge = window.linerElectron;
  if (!bridge?.losslessAnalysisSlice) throw new Error("no analysis");
  const bytes = await bridge.losslessAnalysisSlice(fileId);
  // 22 kHz is plenty for loudness, brightness and beat, and decodes fast
  const context = new OfflineAudioContext(1, 1, 22_050);
  const buffer = await context.decodeAudioData(
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  const from = Math.min(buffer.length, Math.round(buffer.sampleRate));
  const to = Math.min(buffer.length, from + Math.round(20 * buffer.sampleRate));
  const mono = new Float32Array(to - from);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c).subarray(from, to);
    for (let i = 0; i < mono.length; i++)
      mono[i] += data[i] / buffer.numberOfChannels;
  }
  return extractVibe(mono, buffer.sampleRate);
}
