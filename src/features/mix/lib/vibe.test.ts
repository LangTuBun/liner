import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { buildSmartMix } from "./smartMix";
import { extractVibe, type Vibe } from "./vibe";

const RATE = 22_050;

function tone(hz: number, seconds: number, gain: number) {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i++)
    out[i] = gain * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

// a short decaying thump every beat
function beat(bpm: number, seconds: number) {
  const out = new Float32Array(Math.round(RATE * seconds));
  const gap = Math.round((60 / bpm) * RATE);
  for (let start = 0; start < out.length; start += gap)
    for (let i = 0; i < 1500 && start + i < out.length; i++)
      out[start + i] =
        0.8 * Math.exp(-i / 300) * Math.sin((2 * Math.PI * 90 * i) / RATE);
  return out;
}

describe("extractVibe", () => {
  it("reads loudness and brightness", () => {
    const quietLow = extractVibe(tone(300, 5, 0.05), RATE);
    const loudHigh = extractVibe(tone(4000, 5, 0.5), RATE);
    expect(loudHigh.energy).toBeGreaterThan(quietLow.energy + 10);
    expect(loudHigh.brightness).toBeGreaterThan(quietLow.brightness * 5);
  });

  it("finds the tempo of a steady beat", () => {
    const vibe = extractVibe(beat(96, 20), RATE);
    expect(Math.abs(vibe.tempo - 96)).toBeLessThan(5);
    expect(vibe.pulse).toBeGreaterThan(0.2);
  });
});

describe("buildSmartMix with measured sound", () => {
  const make = (id: string, artists: string): Track => ({
    id,
    title: id,
    artists,
    coverUrl: "",
    durationMs: 200_000,
    playCount: 0,
  });

  it("splits one source by how the songs sound", () => {
    const calm: Vibe = { energy: -30, brightness: 900, tempo: 80, pulse: 0.2 };
    const hard: Vibe = { energy: -9, brightness: 4200, tempo: 142, pulse: 0.8 };
    const tracks: Track[] = [];
    const vibes = new Map<string, Vibe>();
    for (let i = 0; i < 12; i++) {
      // artists are mixed across both moods on purpose
      const quiet = make(`q${i}`, `Artist ${i % 4}`);
      const loud = make(`l${i}`, `Artist ${i % 4}`);
      tracks.push(quiet, loud);
      vibes.set(quiet.id, {
        ...calm,
        energy: calm.energy + (i % 3),
        tempo: calm.tempo + (i % 5),
      });
      vibes.set(loud.id, {
        ...hard,
        energy: hard.energy + (i % 3),
        tempo: hard.tempo + (i % 5),
      });
    }
    const result = buildSmartMix([{ id: "all", tracks }], {
      mode: "flow",
      vibes,
      random: () => 0.37,
    });
    expect(result.clusters.length).toBeGreaterThanOrEqual(2);
    for (const group of result.clusters) {
      const firsts = new Set(group.tracks.map((t) => t.id[0]));
      expect(firsts.size).toBe(1);
    }
  });
});
