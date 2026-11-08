import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import type { Vibe } from "@/features/mix/lib/vibe";
import type { TastePlay } from "@/features/taste/lib/tasteModel";
import { correlateQueue } from "./correlateQueue";

const NOW = Date.UTC(2026, 10, 8, 12);

function mkTrack(
  id: string,
  title: string,
  artists: string,
  durationMs = 210_000,
): Track {
  return {
    id,
    title,
    artists,
    coverUrl: "",
    durationMs,
    playCount: 0,
  };
}

describe("correlateQueue", () => {
  it("weaves RDAMVM co-listening matches and spaces out multiple songs by the seed artist", () => {
    const lover = mkTrack("local:1", "Lover", "Taylor Swift");
    const ophelia = mkTrack("local:2", "The Fate of Ophelia", "Taylor Swift");
    const daylight = mkTrack("local:3", "Daylight", "Taylor Swift");
    const ghost = mkTrack("local:4", "Ghost", "Justin Bieber");
    const aboutYou = mkTrack("local:5", "About You", "The 1975");
    const rescued = mkTrack("local:6", "Rescued", "Bruno Mars");
    const wannaBeYours = mkTrack(
      "local:7",
      "I Wanna Be Yours",
      "Arctic Monkeys",
    );
    const nightChanges = mkTrack("local:8", "Night Changes", "One Direction");
    const traitor = mkTrack("local:9", "traitor", "Olivia Rodrigo");
    const unrelated1 = mkTrack("local:10", "闇夜の森", "黒夢", 420_000);
    const unrelated2 = mkTrack("local:11", "강남스타일", "PSY", 110_000);

    // Input list in arbitrary/alphabetical order with unrelated tracks first
    const pool = [
      unrelated1,
      unrelated2,
      daylight,
      ophelia,
      lover,
      traitor,
      nightChanges,
      wannaBeYours,
      rescued,
      aboutYou,
      ghost,
    ];

    // RDAMVM recommendations returned for "Lover"
    const related: Track[] = [
      mkTrack("yt:g", "Ghost", "Justin Bieber"),
      mkTrack("yt:a", "About You", "The 1975"),
      mkTrack("yt:o", "The Fate of Ophelia", "Taylor Swift"),
      mkTrack("yt:b", "Talking to the Moon", "Bruno Mars"),
      mkTrack("yt:d", "Daylight", "Taylor Swift"),
      mkTrack("yt:i", "I Wanna Be Yours", "Arctic Monkeys"),
      mkTrack("yt:n", "Night Changes", "One Direction"),
      mkTrack("yt:t", "traitor", "Olivia Rodrigo"),
    ];

    const queue = correlateQueue(lover, pool, { related, now: NOW });

    expect(queue[0]).toBe(lover);
    // All 9 correlated pop tracks come before the 2 unrelated tracks
    const correlatedIds = new Set([
      lover.id,
      ghost.id,
      aboutYou.id,
      ophelia.id,
      rescued.id,
      daylight.id,
      wannaBeYours.id,
      nightChanges.id,
      traitor.id,
    ]);
    for (const item of queue.slice(0, 9)) {
      expect(correlatedIds.has(item.id)).toBe(true);
    }

    // Taylor Swift tracks are spaced out (never two Taylor Swift tracks back-to-back)
    for (let i = 1; i < 9; i++) {
      expect(
        queue[i].artists === "Taylor Swift" &&
          queue[i - 1].artists === "Taylor Swift",
      ).toBe(false);
    }
  });

  it("uses on-device acoustic vibes offline to keep similar-sounding songs together", () => {
    const seed = mkTrack("local:s", "Soft Ballad", "Artist A");
    const harsh1 = mkTrack("local:h1", "Heavy Club 1", "Artist B");
    const harsh2 = mkTrack("local:h2", "Heavy Club 2", "Artist C");
    const soft1 = mkTrack("local:m1", "Midnight Acoustic", "Artist D");
    const soft2 = mkTrack("local:m2", "Warm Piano", "Artist E");

    const vibes = new Map<string, Vibe>([
      [seed.id, { energy: -18, brightness: 1100, tempo: 82, pulse: 0.25 }],
      [soft1.id, { energy: -17, brightness: 1150, tempo: 84, pulse: 0.28 }],
      [soft2.id, { energy: -19, brightness: 1050, tempo: 80, pulse: 0.22 }],
      [harsh1.id, { energy: -5, brightness: 4200, tempo: 145, pulse: 0.92 }],
      [harsh2.id, { energy: -4, brightness: 4500, tempo: 150, pulse: 0.95 }],
    ]);

    const queue = correlateQueue(seed, [harsh1, harsh2, seed, soft1, soft2], {
      vibes,
      now: NOW,
    });

    expect(queue[0]).toBe(seed);
    expect(new Set(queue.slice(1, 3).map((t) => t.id))).toEqual(
      new Set([soft1.id, soft2.id]),
    );
  });

  it("prioritizes kept artists and learned transition steps over skipped ones", () => {
    const seed = mkTrack("local:s", "Seed Song", "Taylor Swift");
    const skipped = mkTrack("local:sk", "Skipped Song", "Skipped Artist");
    const loved = mkTrack("local:lv", "Loved Song", "The 1975");

    const plays: TastePlay[] = [
      ...Array.from({ length: 12 }, () => ({
        at: NOW - 3600_000,
        artist: "the 1975",
        prev: "taylor swift",
        durationMs: 210_000,
        kept: true,
      })),
      ...Array.from({ length: 12 }, () => ({
        at: NOW - 3600_000,
        artist: "skipped artist",
        prev: "taylor swift",
        durationMs: 210_000,
        kept: false,
      })),
    ];

    const queue = correlateQueue(seed, [seed, skipped, loved], {
      plays,
      now: NOW,
    });

    expect(queue.map((t) => t.id)).toEqual([seed.id, loved.id, skipped.id]);
  });
});
