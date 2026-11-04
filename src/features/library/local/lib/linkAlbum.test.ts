import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";

const { search, getAlbum } = vi.hoisted(() => ({
  search: vi.fn(),
  getAlbum: vi.fn(),
}));

vi.mock("@/shared/api", () => ({ api: { search, getAlbum } }));
vi.mock("@/shared/api/track", () => ({ toClientTrack: (row: Track) => row }));

import { findCatalogAlbum } from "./linkAlbum";
import { trackMatchKey } from "./downloadMatch";
import type { LocalAlbum } from "./albums";

const local = (n: number, title: string, durationMs: number): Track => ({
  id: `local:${n.toString(16).padStart(20, "0")}`,
  title,
  artists: "RPT MCK",
  coverUrl: "",
  durationMs,
  playCount: 0,
});

const album: LocalAlbum = {
  key: "99%",
  title: "99%",
  artist: "RPT MCK",
  coverUrl: "",
  tracks: [local(1, "99", 171_000), local(2, "Badtrip", 158_000)],
};

const catalogRow = (title: string, durationMs: number): Track => ({
  id: title,
  title,
  artists: "MCK",
  coverUrl: "cover.jpg",
  durationMs,
  playCount: 0,
});

describe("findCatalogAlbum", () => {
  beforeEach(() => {
    search.mockReset();
    getAlbum.mockReset();
  });

  it("pairs local songs with the catalog album and stamps the catalog's key", async () => {
    search.mockResolvedValue({
      items: [
        {
          type: "album",
          id: "alb1",
          title: "99%",
          artists: [{ id: "a", name: "MCK" }],
        },
      ],
    });
    getAlbum.mockResolvedValue({
      title: "99%",
      tracks: [catalogRow("99", 171_500), catalogRow("BADTRIP", 158_200)],
    });

    const link = await findCatalogAlbum(album);

    expect(link?.albumId).toBe("alb1");
    expect(link?.coverUrl).toBe("cover.jpg");
    expect(link?.stamps).toEqual([
      { id: "1".padStart(20, "0"), matchKey: trackMatchKey("99", "MCK") },
      { id: "2".padStart(20, "0"), matchKey: trackMatchKey("BADTRIP", "MCK") },
    ]);
  });

  it("gives up on a different edition instead of guessing", async () => {
    search.mockResolvedValue({
      items: [
        {
          type: "album",
          id: "alb2",
          title: "99%",
          artists: [{ id: "a", name: "MCK" }],
        },
      ],
    });
    getAlbum.mockResolvedValue({
      title: "99%",
      tracks: Array.from({ length: 12 }, (_, i) => catalogRow(`Song ${i}`, 1)),
    });
    expect(await findCatalogAlbum(album)).toBeNull();
  });

  it("skips results with another title or artist", async () => {
    search.mockResolvedValue({
      items: [
        {
          type: "album",
          id: "x",
          title: "99 Problems",
          artists: [{ id: "a", name: "MCK" }],
        },
        {
          type: "album",
          id: "y",
          title: "99%",
          artists: [{ id: "b", name: "Someone Else" }],
        },
      ],
    });
    expect(await findCatalogAlbum(album)).toBeNull();
    expect(getAlbum).not.toHaveBeenCalled();
  });
});
