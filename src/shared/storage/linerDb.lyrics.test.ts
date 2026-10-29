import { describe, expect, it } from "vitest";
import { linerDb } from "./linerDb";
import { isLocalTrackId } from "@/shared/media/local";
import type { LyricsCandidate } from "@/shared/contracts/lyrics";

function candidate(provider: string): LyricsCandidate {
  return {
    provider,
    contentKind: "lyrics",
    syncLevel: "line_level",
    quality: { total: 80 },
    lyrics: { content: "[00:01.00] line", format: "lrc" },
  } as unknown as LyricsCandidate;
}

async function store(trackId: string) {
  const best = candidate("lrclib");
  await linerDb.putLyrics({
    trackId,
    syncLevel: best.syncLevel,
    quality: best.quality.total,
    activeProvider: best.provider,
    availableProviders: [],
    rawLyrics: best.lyrics.content,
    rawFormat: best.lyrics.format,
    candidate: best,
    lastCheckedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

describe("lyrics storage for local tracks", () => {
  it("keeps local track lyrics when the lyrics cache is cleared", async () => {
    await store("local:keep");
    await store("catalog-track");

    await linerDb.clearCachedLyrics(isLocalTrackId);

    expect(await linerDb.getLyrics("local:keep")).not.toBeNull();
    expect(await linerDb.getLyrics("catalog-track")).toBeNull();
  });

  it("drops lyrics once the local track is removed", async () => {
    await store("local:gone");

    await linerDb.deleteLyrics(["local:gone"]);

    expect(await linerDb.getLyrics("local:gone")).toBeNull();
  });
});
