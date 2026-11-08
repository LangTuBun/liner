import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { rankByTaste, sampleBeta, type TastePlay } from "./tasteModel";

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = Date.UTC(2026, 10, 7, 12);
const track = (id: string, artists: string): Track => ({
  id,
  title: id,
  artists,
  coverUrl: "",
  durationMs: 200_000,
  playCount: 0,
});
const play = (artist: string, kept: boolean): TastePlay => ({
  at: NOW - 3600_000,
  artist,
  prev: "",
  durationMs: 200_000,
  kept,
});

describe("sampleBeta", () => {
  it("centres on hits / (hits + misses)", () => {
    const random = seeded(1);
    let sum = 0;
    for (let i = 0; i < 2000; i++) sum += sampleBeta(18, 2, random);
    expect(sum / 2000).toBeCloseTo(20 / 24, 1);
  });
});

describe("rankByTaste", () => {
  it("keeps the order when nothing has been played", () => {
    const list = [track("a", "A"), track("b", "B")];
    expect(rankByTaste(list, null, [])).toBe(list);
  });

  it("puts kept artists before skipped ones", () => {
    const plays = [
      ...Array.from({ length: 20 }, () => play("loved", true)),
      ...Array.from({ length: 20 }, () => play("hated", false)),
    ];
    const list = [track("h", "Hated"), track("l", "Loved")];
    const ranked = rankByTaste(list, null, plays, NOW, seeded(7));
    expect(ranked.map((t) => t.id)).toEqual(["l", "h"]);
  });
});
