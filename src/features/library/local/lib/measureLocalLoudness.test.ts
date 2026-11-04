import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initLocalLoudness } from "./measureLocalLoudness";
import type { LocalTrackRecord } from "@/shared/media/local";

describe("compressed local loudness background analysis", () => {
  let records: LocalTrackRecord[];
  let changed: () => void;
  const store = vi.fn();
  const decode = vi.fn();
  const fetchAudio = vi.fn();
  const terminate = vi.fn();
  const record = (
    id: string,
    extension = "flac",
    addedAt = 1,
  ): LocalTrackRecord =>
    ({
      id,
      audioFile: `${id}.${extension}`,
      contentHash: id,
      addedAt,
      byteSize: 16,
      durationMs: 1000,
      sampleRate: 48000,
    }) as LocalTrackRecord;

  beforeEach(() => {
    vi.useFakeTimers();
    records = [];
    store.mockReset().mockImplementation(async (id, _file, _hash, result) => {
      records = records.map((r) => (r.id === id ? { ...r, ...result } : r));
      changed();
      return true;
    });
    decode.mockReset().mockResolvedValue({
      sampleRate: 48000,
      length: 48000,
      numberOfChannels: 2,
      getChannelData: () => new Float32Array(48000),
    });
    fetchAudio
      .mockReset()
      .mockImplementation(async () => new Response(new Uint8Array(16)));
    terminate.mockReset();
    vi.stubGlobal("fetch", fetchAudio);
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData = decode;
      },
    );
    vi.stubGlobal(
      "Worker",
      class {
        onmessage?: (event: { data: unknown }) => void;
        terminate = terminate;
        postMessage() {
          queueMicrotask(() =>
            this.onmessage?.({ data: { loudnessLufs: -23, peakDb: -20 } }),
          );
        }
      },
    );
    Object.defineProperty(window, "linerElectron", {
      configurable: true,
      value: {
        localTracksList: async () => [...records],
        localTracksLoudness: store,
        onLocalTracksChanged: (callback: () => void) => {
          changed = callback;
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "linerElectron");
  });

  it("decodes supported compressed containers newest first, persists once, and backfills on changes", async () => {
    records = ["flac", "mp3", "m4a", "ogg", "opus", "webm", "aac"].map(
      (ext, i) => record(ext, ext, i),
    );
    records.push(record("wav", "wav"));
    initLocalLoudness();
    await vi.runAllTimersAsync();
    expect(store.mock.calls.map((call) => call[0])).toEqual([
      "aac",
      "webm",
      "opus",
      "ogg",
      "m4a",
      "mp3",
      "flac",
    ]);
    expect(store).toHaveBeenLastCalledWith("flac", "flac.flac", "flac", {
      loudnessLufs: -23,
      peakDb: -20,
    });
    expect(terminate).toHaveBeenCalledTimes(7);
    changed();
    await vi.runAllTimersAsync();
    expect(decode).toHaveBeenCalledTimes(7);
    records.push(record("new"));
    changed();
    await vi.runAllTimersAsync();
    expect(store).toHaveBeenCalledTimes(8);
  });

  it("skips files above the encoded or decoded memory cap", async () => {
    records = [
      { ...record("large"), byteSize: 65 * 1024 * 1024 },
      { ...record("long"), durationMs: 3600000 },
      { ...record("done"), loudnessLufs: null, peakDb: null },
    ];
    initLocalLoudness();
    await vi.runAllTimersAsync();
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("continues after a decoder failure without retrying it on every notification", async () => {
    records = [record("good"), record("bad", "aac", 2)];
    decode.mockRejectedValueOnce(new Error("Unsupported decoder"));
    initLocalLoudness();
    await vi.runAllTimersAsync();
    changed();
    await vi.runAllTimersAsync();
    expect(decode).toHaveBeenCalledTimes(2);
    expect(store).toHaveBeenCalledTimes(1);
    expect(store.mock.calls[0][0]).toBe("good");
  });
});
