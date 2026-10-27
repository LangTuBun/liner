import { describe, expect, it } from "vitest";
import { recordProgress, type ProgressLog } from "./stall";

const TICK = 5_000;

// feeds one reading per tick; returns the second at which it was called stuck
function run(percentAt: (second: number) => number, seconds: number) {
  const log: ProgressLog = { since: 0, samples: [] };
  for (let t = 0; t <= seconds; t += TICK / 1000) {
    if (recordProgress(log, percentAt(t), t * 1000, TICK)) return t;
  }
  return null;
}

describe("recordProgress", () => {
  it("calls a transfer stuck at 0% after the first minute", () => {
    expect(run(() => 0, 300)).toBe(60);
  });

  it("calls a crawl of 1 point a minute stuck", () => {
    const stuckAt = run((s) => Math.floor(s / 60), 400);
    expect(stuckAt).not.toBeNull();
    expect(stuckAt!).toBeLessThanOrEqual(130);
  });

  it("leaves a healthy transfer alone", () => {
    // half a point a second: 30 points a minute, done in about 3 minutes
    expect(run((s) => Math.min(100, s * 0.5), 300)).toBeNull();
  });

  it("does not call a transfer stuck when it is nearly done", () => {
    expect(run((s) => (s < 20 ? s * 4 : 95), 300)).toBeNull();
  });

  it("gives up on anything still going after eight minutes", () => {
    // 4 points a minute: moving, but it would take 25 minutes
    const at = run((s) => Math.floor(s / 15), 900);
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThan(480);
  });
});
