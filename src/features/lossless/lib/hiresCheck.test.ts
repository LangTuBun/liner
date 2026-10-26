import { describe, expect, it } from "vitest";
import { bandLevelsDb, judgeHiRes } from "./hiresCheck";

const RATE = 96_000;

function tones(freqs: number[], seconds = 2): Float32Array {
  const out = new Float32Array(RATE * seconds);
  for (let i = 0; i < out.length; i++) {
    for (const f of freqs)
      out[i] += (0.5 / freqs.length) * Math.sin((2 * Math.PI * f * i) / RATE);
  }
  return out;
}

describe("bandLevelsDb", () => {
  it("reads a full-scale sine at about -3 dBFS", () => {
    const sine = new Float32Array(RATE);
    for (let i = 0; i < sine.length; i++)
      sine[i] = Math.sin((2 * Math.PI * 19_000 * i) / RATE);
    const [level] = bandLevelsDb(sine, RATE, [[17_000, 21_000]]);
    expect(level).toBeGreaterThan(-3.5);
    expect(level).toBeLessThan(-2.5);
  });
});

describe("judgeHiRes", () => {
  it("calls content that stops at 22 kHz upsampled", () => {
    expect(judgeHiRes(tones([1_000, 19_000]), RATE).verdict).toBe("upsampled");
  });

  it("calls content above 22 kHz real hi-res", () => {
    expect(
      judgeHiRes(tones([1_000, 19_000, 27_000, 35_000]), RATE).verdict,
    ).toBe("hires");
  });

  it("calls resampler residue with silence above 30 kHz upsampled", () => {
    const residue = tones([1_000, 19_000]);
    const leak = tones([25_000]);
    for (let i = 0; i < residue.length; i++) residue[i] += leak[i] * 1e-4;
    expect(judgeHiRes(residue, RATE).verdict).toBe("upsampled");
  });

  it("cannot judge silence", () => {
    expect(judgeHiRes(new Float32Array(RATE), RATE).verdict).toBe("unknown");
  });
});
