// a transfer that gains under 3 points in a minute is stuck, not slow; after
// 8 minutes it is too late whatever it is doing
export const STALL_GRACE_MS = 60_000;
export const STALL_WINDOW_MS = 60_000;
export const STALL_MIN_GAIN = 3;
export const DOWNLOAD_MAX_MS = 8 * 60_000;
export const NEARLY_DONE = 90;

export interface ProgressLog {
  since: number;
  samples: { time: number; percent: number }[];
}

// call once per check with the current progress; true once the transfer has
// gone a minute without moving
export function recordProgress(
  log: ProgressLog,
  percent: number,
  now: number,
  checkEveryMs: number,
): boolean {
  log.samples.push({ time: now, percent });
  log.samples = log.samples.filter(
    (sample) => sample.time >= now - 2 * STALL_WINDOW_MS,
  );
  if (percent >= NEARLY_DONE) return false;
  if (now - log.since > DOWNLOAD_MAX_MS) return true;
  if (now - log.since < STALL_GRACE_MS) return false;
  const base = log.samples.find(
    (sample) => sample.time >= now - STALL_WINDOW_MS - checkEveryMs,
  );
  return percent - (base?.percent ?? percent) < STALL_MIN_GAIN;
}
