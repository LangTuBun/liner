import type { LoudnessMeasurement } from "../../../../../electron/local-tracks/loudness";
import {
  localTrackAudioUrl,
  toLocalTrackId,
  type LocalTrackRecord,
} from "@/shared/media/local";

const MAX_ENCODED_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_BYTES = 256 * 1024 * 1024;

async function measureCompressed(
  record: LocalTrackRecord,
): Promise<LoudnessMeasurement | null> {
  const rate = record.sampleRate || 48000;
  // shortcut: whole-file browser decoding is capped; use a streaming decoder if larger compressed files need matching.
  if (
    record.byteSize > MAX_ENCODED_BYTES ||
    !record.durationMs ||
    (record.durationMs / 1000) * rate * 2 * 4 > MAX_DECODED_BYTES
  )
    return null;
  const response = await fetch(localTrackAudioUrl(toLocalTrackId(record.id)));
  if (
    !response.ok ||
    Number(response.headers.get("content-length")) > MAX_ENCODED_BYTES
  )
    return null;
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_ENCODED_BYTES) return null;
  const context = new OfflineAudioContext(2, 1, rate);
  const audio = await context.decodeAudioData(bytes);
  if (
    audio.numberOfChannels > 2 ||
    audio.length * audio.numberOfChannels * 4 > MAX_DECODED_BYTES
  )
    return null;
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) =>
    audio.getChannelData(c),
  );
  const worker = new Worker(new URL("./loudnessWorker.ts", import.meta.url), {
    type: "module",
  });
  try {
    return await new Promise<LoudnessMeasurement | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 120000);
      const done = (value: LoudnessMeasurement | null) => {
        clearTimeout(timeout);
        resolve(value);
      };
      worker.onmessage = (event: MessageEvent<LoudnessMeasurement | null>) =>
        done(event.data);
      worker.onerror = () => done(null);
      worker.postMessage({ sampleRate: audio.sampleRate, channels });
    });
  } finally {
    worker.terminate();
  }
}

export function initLocalLoudness() {
  const bridge = window.linerElectron;
  if (!bridge?.localTracksLoudness) return;
  const attempted = new Set<string>();
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const records = (await bridge.localTracksList()).sort(
          (a, b) => b.addedAt - a.addedAt,
        );
        const record = records.find(
          (r) =>
            r.loudnessLufs === undefined &&
            !r.audioFile.endsWith(".wav") &&
            !attempted.has(`${r.id}|${r.audioFile}|${r.contentHash}`),
        );
        if (!record) break;
        attempted.add(`${record.id}|${record.audioFile}|${record.contentHash}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          const measurement = await measureCompressed(record);
          if (measurement)
            await bridge.localTracksLoudness(
              record.id,
              record.audioFile,
              record.contentHash,
              measurement,
            );
        } catch {
          // Decoding support varies by platform; failure never affects playback or import.
        }
      }
    } finally {
      running = false;
    }
  };
  bridge.onLocalTracksChanged?.(() => {
    void run().catch(() => undefined);
  });
  void run().catch(() => undefined);
}
