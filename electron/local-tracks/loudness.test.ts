import { describe, expect, it } from "vitest";
import { LoudnessMeter, volumeMatchDb } from "./loudness";

function sine(rate: number, db: number, seconds = 3) {
  return Float32Array.from(
    { length: rate * seconds },
    (_, i) => 10 ** (db / 20) * Math.sin((2 * Math.PI * 997 * i) / rate),
  );
}

function measure(rate: number, channels: Float32Array[]) {
  const meter = new LoudnessMeter(rate, channels.length);
  // Uneven chunks exercise filter state and overlapping block boundaries.
  for (let offset = 0; offset < channels[0].length; offset += 7919)
    meter.push(channels.map((c) => c.subarray(offset, offset + 7919)));
  return meter.finish();
}

describe("BS.1770-4 integrated loudness", () => {
  for (const rate of [44100, 48000, 176400]) {
    for (const db of [-23, -20]) {
      it(`measures a ${db} dBFS 997 Hz stereo sine at ${rate} Hz`, () => {
        const tone = sine(rate, db);
        const result = measure(rate, [tone, tone]);
        expect(result.loudnessLufs).toBeCloseTo(db, 1);
        expect(result.peakDb).toBeCloseTo(db, 3);
      });
    }
  }

  it("sums mono/stereo channel energies without compensating mono", () => {
    const tone = sine(48000, -23);
    const mono = measure(48000, [tone]);
    const stereo = measure(48000, [tone, tone]);
    expect(stereo.loudnessLufs! - mono.loudnessLufs!).toBeCloseTo(
      10 * Math.log10(2),
      8,
    );
    expect(mono.peakDb).toBe(stereo.peakDb);
  });

  it("handles silence, sub-gate content, and incomplete blocks", () => {
    expect(measure(48000, [new Float32Array(48000)])).toEqual({
      loudnessLufs: null,
      peakDb: null,
    });
    expect(measure(48000, [sine(48000, -80)]).loudnessLufs).toBeNull();
    expect(measure(48000, [sine(48000, -20, 0.1)]).loudnessLufs).toBeNull();
  });

  it("excludes quiet passages with the relative gate", () => {
    const tone = sine(48000, -20, 5);
    const quiet = sine(48000, -50, 10);
    const combined = new Float32Array(tone.length + quiet.length);
    combined.set(tone);
    combined.set(quiet, tone.length);
    expect(
      Math.abs(measure(48000, [combined, combined]).loudnessLufs! + 20),
    ).toBeLessThan(0.15);
  });

  it("rejects unsupported layouts and invalid samples", () => {
    expect(() => new LoudnessMeter(48000, 6)).toThrow();
    expect(() => new LoudnessMeter(0, 2)).toThrow();
    expect(() =>
      new LoudnessMeter(48000, 1).push([Float32Array.of(NaN)]),
    ).toThrow();
  });

  it("prints the reference measurement used in the report", () => {
    const tone = sine(48000, -23);
    const reference = measure(48000, [tone, tone]);
    console.info("997 Hz stereo reference, -23 dBFS peak, 48 kHz:", reference);
    expect(Math.abs(reference.loudnessLufs! + 23)).toBeLessThan(0.1);
  });
});

describe("volume match gain", () => {
  it.each([
    [-9.5, 0, -4.5],
    [-20.2, -4.2, 3.2],
    [-40, -30, 12],
    [15, 0, -24],
    [-14, -6, 0],
    [-14, 0, -1],
  ])("matches %s LUFS / %s dBFS to %s dB", (loudnessLufs, peakDb, expected) => {
    const gain = volumeMatchDb(true, { loudnessLufs, peakDb });
    expect(gain).toBeCloseTo(expected, 8);
    expect(peakDb + gain).toBeLessThanOrEqual(-1);
  });

  it("leaves disabled, missing, silent and invalid measurements at unity", () => {
    expect(volumeMatchDb(false, { loudnessLufs: -30, peakDb: -20 })).toBe(0);
    for (const value of [
      undefined,
      null,
      {},
      { loudnessLufs: null, peakDb: null },
      { loudnessLufs: NaN, peakDb: -10 },
      { loudnessLufs: -20 },
    ])
      expect(volumeMatchDb(true, value)).toBe(0);
  });
});
