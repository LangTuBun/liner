import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { buildSmartMix } from "./smartMix";

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function track(id: string, title: string, artists: string): Track {
  return {
    id,
    title,
    artists,
    coverUrl: "",
    durationMs: 200_000,
    playCount: 0,
  };
}

function songs(artists: string[], perArtist: number, prefix: string) {
  return artists.flatMap((artist) =>
    Array.from({ length: perArtist }, (_, i) =>
      track(`${prefix}-${artist}-${i}`, `${artist} song ${i}`, artist),
    ),
  );
}

const chill = songs(["Laufey", "keshi", "Clairo"], 6, "c");
const loud = songs(["Joji", "Juice", "Lil Peep"], 6, "l");

describe("buildSmartMix", () => {
  it("keeps every song once and finds the two playlists as clusters", () => {
    const result = buildSmartMix(
      [
        { id: "chill", tracks: chill },
        { id: "loud", tracks: loud },
      ],
      { mode: "flow", clusterCount: 2, random: seeded(1) },
    );
    expect(result.combined).toHaveLength(36);
    expect(new Set(result.combined.map((t) => t.id)).size).toBe(36);
    expect(result.clusters).toHaveLength(2);
    for (const group of result.clusters) {
      const fromChill = group.tracks.filter((t) => t.id.startsWith("c-"));
      expect([0, group.tracks.length]).toContain(fromChill.length);
    }
  });

  it("drops a song that sits in two sources and keeps the downloaded copy", () => {
    const streamed = track("yt1", "Lover Girl", "Laufey");
    const local = track("local:abc", "Lover Girl (Official Audio)", "Laufey");
    const result = buildSmartMix(
      [
        { id: "a", tracks: [streamed, ...chill] },
        { id: "b", tracks: [local, ...loud] },
      ],
      { mode: "variety", random: seeded(2) },
    );
    expect(result.duplicatesRemoved).toBe(1);
    expect(result.combined.filter((t) => t.title.includes("Lover"))).toEqual([
      local,
    ]);
  });

  it("variety mode never plays the same artist twice in a row when it can avoid it", () => {
    const result = buildSmartMix(
      [
        { id: "chill", tracks: chill },
        { id: "loud", tracks: loud },
      ],
      { mode: "variety", random: seeded(3) },
    );
    const clashes = result.combined.filter(
      (t, i) => i > 0 && t.artists === result.combined[i - 1].artists,
    );
    expect(clashes).toHaveLength(0);
  });

  it("finds the number of mixes on its own", () => {
    const a = songs(["A1", "A2", "A3"], 5, "a");
    const b = songs(["B1", "B2", "B3"], 5, "b");
    const c = songs(["C1", "C2", "C3"], 5, "c");
    const result = buildSmartMix(
      [
        { id: "a", tracks: a },
        { id: "b", tracks: b },
        { id: "c", tracks: c },
      ],
      { mode: "flow", random: seeded(7) },
    );
    expect(result.clusters).toHaveLength(3);
    for (const group of result.clusters) {
      const origins = new Set(group.tracks.map((t) => t.id[0]));
      expect(origins.size).toBe(1);
    }
  });

  it("handles an empty and a tiny selection", () => {
    expect(buildSmartMix([], { mode: "flow" }).combined).toEqual([]);
    const tiny = buildSmartMix([{ id: "a", tracks: chill.slice(0, 3) }], {
      mode: "flow",
    });
    expect(tiny.clusters).toHaveLength(1);
    expect(tiny.combined).toHaveLength(3);
  });
});
