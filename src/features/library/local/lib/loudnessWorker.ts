import { LoudnessMeter } from "../../../../../electron/local-tracks/loudness";

self.onmessage = (
  event: MessageEvent<{ sampleRate: number; channels: Float32Array[] }>,
) => {
  try {
    const { sampleRate, channels } = event.data;
    const meter = new LoudnessMeter(sampleRate, channels.length);
    meter.push(channels);
    self.postMessage(meter.finish());
  } catch {
    self.postMessage(null);
  }
};
