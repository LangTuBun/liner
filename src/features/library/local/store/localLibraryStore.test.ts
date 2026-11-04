import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTrackRecord } from "@/shared/media/local";

vi.mock("@/features/player/engine/playerEngine", () => ({ playerEngine: {} }));

describe("local library measurement notifications", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "linerElectron");
  });

  it("reloads a measurement notification received during an existing load", async () => {
    let changed = () => {};
    let resolveFirst!: (records: LocalTrackRecord[]) => void;
    const record: LocalTrackRecord = {
      id: "file",
      title: "Song",
      artist: "Artist",
      durationMs: 1000,
      fileName: "song.wav",
      audioFile: "file.wav",
      mimeType: "audio/wav",
      byteSize: 100,
      addedAt: 1,
    };
    const measured = { ...record, loudnessLufs: -23, peakDb: -20 };
    const list = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<LocalTrackRecord[]>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValue([measured]);
    Object.defineProperty(window, "linerElectron", {
      configurable: true,
      value: {
        localTracksList: list,
        onLocalTracksChanged: (callback: () => void) => {
          changed = callback;
        },
      },
    });
    const { useLocalLibraryStore } = await import("./localLibraryStore");
    const loading = useLocalLibraryStore.getState().load();
    changed();
    resolveFirst([record]);
    await loading;
    await vi.waitFor(() =>
      expect(useLocalLibraryStore.getState().records).toEqual([measured]),
    );
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not duplicate an import whose save notification already loaded the record", async () => {
    let changed = () => {};
    const record: LocalTrackRecord = {
      id: "file",
      title: "Song",
      artist: "Artist",
      durationMs: 1000,
      fileName: "song.wav",
      audioFile: "file.wav",
      mimeType: "audio/wav",
      byteSize: 100,
      addedAt: 1,
    };
    let records: LocalTrackRecord[] = [];
    Object.defineProperty(window, "linerElectron", {
      configurable: true,
      value: {
        localTracksList: async () => records,
        onLocalTracksChanged: (callback: () => void) => {
          changed = callback;
        },
        localTracksImport: async () => {
          records = [record];
          changed();
          await Promise.resolve();
          await Promise.resolve();
          return { added: [record], duplicates: 0, failed: [] };
        },
      },
    });
    const { useLocalLibraryStore } = await import("./localLibraryStore");
    await useLocalLibraryStore.getState().load();
    await useLocalLibraryStore.getState().importPaths(["song.wav"]);
    expect(useLocalLibraryStore.getState().records).toEqual([record]);
  });
});
