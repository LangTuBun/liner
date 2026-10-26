import { useEffect, useRef, useState } from "react";
import { Dialog, DialogHeader } from "@/shared/ui";
import { useTranslation } from "@/languages";
import { cn } from "@/shared/lib/utils";
import { usePlayerStore } from "@/features/player";
import { playerRuntime } from "@/features/player/engine/playerRuntime";
import {
  pitchShifter,
  type QualityMonitorTaps,
} from "@/features/player/engine/pitchShifter";
import { eqPreampDb, isEqActive } from "@/features/player/engine/equalizer";
import { isLocalTrackId, localFileId } from "@/shared/media/local";
import { useAudioQualityStore } from "../store/audioQualityStore";
import {
  bandwidthVerdict,
  estimateBandwidth,
  formatKbps,
  formatRate,
  matchEndpoint,
  summarizeSource,
  toDb,
  type LocalAudioFormat,
  type OutputEndpoint,
  type SourceSummary,
} from "../lib/audioQuality";

const font = { fontFamily: "var(--font-inter), sans-serif" } as const;
const SLOW_TICK_MS = 500;
const SPECTRUM_FLOOR_DB = -130;
const METER_RANGE_DB = 60;

interface EngineInfo {
  sampleRate: number;
  channels: number;
  latencyMs: number;
  state: AudioContextState;
}

interface Snapshot {
  source: SourceSummary | null;
  playing: boolean;
  engine: EngineInfo | null;
  bufferedSec: number | null;
  deviceLabel: string;
  device: OutputEndpoint | null;
  endpointsSupported: boolean;
}

interface LiveState {
  spectrum: Float32Array | null;
  frames: number;
  cutoff: number | null;
  peakHold: number;
  clips: number;
  key: string;
}

const emptyLive = (key = ""): LiveState => ({
  spectrum: null,
  frames: 0,
  cutoff: null,
  peakHold: -Infinity,
  clips: 0,
  key,
});

function dbText(db: number): string {
  if (!Number.isFinite(db)) return "−∞ dBFS";
  return `${db > 0 ? "+" : ""}${db.toFixed(1)} dBFS`;
}

function meterPercent(db: number): string {
  if (!Number.isFinite(db)) return "0%";
  return `${Math.max(0, Math.min(100, ((db + METER_RANGE_DB) / METER_RANGE_DB) * 100))}%`;
}

function bufferedAhead(audio: HTMLAudioElement): number | null {
  const ranges = audio.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (
      ranges.start(i) <= audio.currentTime &&
      ranges.end(i) >= audio.currentTime
    )
      return ranges.end(i) - audio.currentTime;
  }
  return ranges.length ? 0 : null;
}

function audioElement(): HTMLAudioElement | null {
  const win = window as unknown as { __liner_audio?: HTMLAudioElement };
  return (
    win.__liner_audio ??
    (document.getElementById("liner-audio") as HTMLAudioElement | null)
  );
}

function Stage({
  title,
  main,
  sub,
  rows,
}: {
  title: string;
  main: string;
  sub: string;
  rows: Array<[string, string]>;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-[10px] rounded-[12px] bg-black/[0.04] p-[14px] dark:bg-white/[0.08]">
      <div className="flex flex-col gap-[2px]">
        <span
          className="text-[12px] font-[500] text-text-tertiary"
          style={font}
        >
          {title}
        </span>
        <span
          className="truncate text-[16px] font-[600] tabular-nums text-text-primary"
          style={font}
        >
          {main}
        </span>
        <span
          className="text-[12px] leading-[1.35] text-text-tertiary"
          style={font}
        >
          {sub}
        </span>
      </div>
      <div className="flex flex-col gap-[5px]">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-[10px] text-[12.5px]"
            style={font}
          >
            <span className="shrink-0 text-text-tertiary">{label}</span>
            <span className="truncate text-right tabular-nums text-text-primary">
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AudioQualityPanel() {
  const { t } = useTranslation();
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const volume = usePlayerStore((s) => s.volume);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const isPitchLinked = usePlayerStore((s) => s.isPitchLinked);
  const pitchSemitones = usePlayerStore((s) => s.pitchSemitones);
  const isReverbEnabled = usePlayerStore((s) => s.isReverbEnabled);
  const reverbLevel = usePlayerStore((s) => s.reverbLevel);
  const isEqEnabled = usePlayerStore((s) => s.isEqEnabled);
  const eqGains = usePlayerStore((s) => s.eqGains);

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [cutoff, setCutoff] = useState<number | null>(null);
  const [stats, setStats] = useState({ peakHold: -Infinity, clips: 0 });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const meterRefs = {
    lRms: useRef<HTMLDivElement>(null),
    lPeak: useRef<HTMLDivElement>(null),
    lNum: useRef<HTMLSpanElement>(null),
    rRms: useRef<HTMLDivElement>(null),
    rPeak: useRef<HTMLDivElement>(null),
    rNum: useRef<HTMLSpanElement>(null),
  };
  const localProbe = useRef<{ id: string; format: LocalAudioFormat | null }>({
    id: "",
    format: null,
  });

  useEffect(() => {
    let raf = 0;
    let lastSlow = -Infinity;
    let taps: QualityMonitorTaps | null = null;
    let live = emptyLive();
    let freq: Float32Array<ArrayBuffer> | null = null;
    let time: Float32Array<ArrayBuffer> | null = null;
    let endpoints: {
      at: number;
      supported: boolean;
      list: OutputEndpoint[];
    } | null = null;
    let deviceLabel = "";
    let disposed = false;

    const loadDevice = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter((d) => d.kind === "audiooutput");
        const device =
          outputs.find((d) => d.deviceId === "default") ?? outputs[0];
        deviceLabel = device?.label ?? "";
      } catch {
        deviceLabel = "";
      }
      const bridge = window.linerElectron;
      if (bridge?.audioOutputEndpoints) {
        const data = await bridge.audioOutputEndpoints().catch(() => null);
        endpoints = data
          ? { at: Date.now(), supported: data.supported, list: data.endpoints }
          : null;
      }
    };

    const probeLocal = (trackId: string) => {
      const id = localFileId(trackId);
      if (localProbe.current.id === id) return;
      localProbe.current = { id, format: null };
      void window.linerElectron
        ?.localTracksProbe?.(id)
        .then((format) => {
          if (localProbe.current.id === id) localProbe.current.format = format;
        })
        .catch(() => undefined);
    };

    const slowTick = () => {
      const audio = audioElement();
      const info = playerRuntime?.getAttachedSource() ?? null;
      if (info && isLocalTrackId(info.trackId)) probeLocal(info.trackId);
      const key = info ? `${info.trackId}|${info.origin}` : "";
      if (key !== live.key) {
        live = emptyLive(key);
        setCutoff(null);
        setStats({ peakHold: -Infinity, clips: 0 });
      }
      const durationSec =
        audio && Number.isFinite(audio.duration) ? audio.duration : 0;
      const ctx = taps?.context ?? null;
      const device =
        endpoints && endpoints.supported
          ? matchEndpoint(deviceLabel, endpoints.list)
          : null;
      setSnapshot({
        source: summarizeSource(info, localProbe.current.format, durationSec),
        playing: Boolean(audio && !audio.paused),
        engine: ctx
          ? {
              sampleRate: ctx.sampleRate,
              channels: ctx.destination.channelCount,
              latencyMs:
                ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000,
              state: ctx.state,
            }
          : null,
        bufferedSec: audio ? bufferedAhead(audio) : null,
        deviceLabel: deviceLabel.replace(
          /^(Default|Communications)\s*[-–—:]\s*/i,
          "",
        ),
        device,
        endpointsSupported: endpoints?.supported ?? true,
      });
      setStats({ peakHold: live.peakHold, clips: live.clips });
      if (endpoints && Date.now() - endpoints.at > 15_000) {
        endpoints.at = Date.now();
        void loadDevice();
      }
    };

    const meter = (
      analyser: AnalyserNode,
      rms: HTMLDivElement | null,
      peakEl: HTMLDivElement | null,
      num: HTMLSpanElement | null,
    ) => {
      if (!time || time.length !== analyser.fftSize)
        time = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(time);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < time.length; i++) {
        const v = Math.abs(time[i]);
        if (v > peak) peak = v;
        sum += v * v;
      }
      const rmsDb = toDb(Math.sqrt(sum / time.length));
      const peakDb = toDb(peak);
      if (rms) rms.style.width = meterPercent(rmsDb);
      if (peakEl) peakEl.style.left = meterPercent(peakDb);
      if (num)
        num.textContent = Number.isFinite(peakDb) ? peakDb.toFixed(1) : "−∞";
      return peak;
    };

    const drawSpectrum = (rate: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !live.spectrum) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (!w || !h) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const g = canvas.getContext("2d");
      if (!g) return;
      const css = getComputedStyle(canvas);
      const line = css.getPropertyValue("--accent-primary").trim() || "#ff3b3b";
      const text = css.getPropertyValue("--text-tertiary").trim() || "#888";
      g.clearRect(0, 0, w, h);
      const nyquist = rate / 2;
      const fMin = 20;
      const xOf = (f: number) =>
        (Math.log(f / fMin) / Math.log(nyquist / fMin)) * w;
      const yOf = (db: number) =>
        Math.max(0, Math.min(h, (db / SPECTRUM_FLOOR_DB) * h));
      g.strokeStyle = text;
      g.fillStyle = text;
      g.globalAlpha = 0.35;
      g.lineWidth = 1;
      g.font = `${10 * dpr}px sans-serif`;
      for (const f of [100, 1000, 10000, 20000]) {
        if (f >= nyquist) continue;
        const x = xOf(f);
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
        g.fillText(
          f >= 1000 ? `${f / 1000}k` : String(f),
          x + 3 * dpr,
          h - 4 * dpr,
        );
      }
      g.globalAlpha = 1;
      const bins = live.spectrum;
      const hzPerBin = nyquist / bins.length;
      g.beginPath();
      for (let px = 0; px < w; px++) {
        const f = fMin * Math.pow(nyquist / fMin, px / w);
        const i = Math.min(
          bins.length - 1,
          Math.max(1, Math.round(f / hzPerBin)),
        );
        const y = yOf(bins[i]);
        if (px === 0) g.moveTo(px, y);
        else g.lineTo(px, y);
      }
      g.strokeStyle = line;
      g.lineWidth = 1.5 * dpr;
      g.stroke();
      g.lineTo(w, h);
      g.lineTo(0, h);
      g.closePath();
      g.globalAlpha = 0.15;
      g.fillStyle = line;
      g.fill();
      g.globalAlpha = 1;
      if (live.cutoff && live.cutoff < nyquist) {
        const x = xOf(live.cutoff);
        g.setLineDash([4 * dpr, 4 * dpr]);
        g.strokeStyle = text;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
        g.setLineDash([]);
      }
    };

    const tick = (ts: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(tick);
      if (!taps) taps = pitchShifter.attachQualityMonitor();
      if (ts - lastSlow > SLOW_TICK_MS) {
        lastSlow = ts;
        slowTick();
      }
      const audio = audioElement();
      if (!taps || taps.context.state !== "running" || !audio || audio.paused)
        return;
      const peak = Math.max(
        meter(
          taps.left,
          meterRefs.lRms.current,
          meterRefs.lPeak.current,
          meterRefs.lNum.current,
        ),
        meter(
          taps.right,
          meterRefs.rRms.current,
          meterRefs.rPeak.current,
          meterRefs.rNum.current,
        ),
      );
      if (peak >= 0.9999) live.clips++;
      live.peakHold = Math.max(live.peakHold, toDb(peak));

      const analyser = taps.source;
      if (!freq || freq.length !== analyser.frequencyBinCount)
        freq = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(freq);
      let loudest = -Infinity;
      for (let i = 0; i < freq.length; i += 16)
        loudest = Math.max(loudest, freq[i]);
      // average the spectrum only while there is signal, so quiet gaps do not
      // drag the bandwidth estimate down
      if (loudest > -100) {
        if (!live.spectrum || live.spectrum.length !== freq.length)
          live.spectrum = Float32Array.from(freq, (v) =>
            Number.isFinite(v) ? v : -140,
          );
        const k = live.frames < 30 ? 1 / (live.frames + 1) : 0.03;
        for (let i = 0; i < freq.length; i++) {
          const v = Number.isFinite(freq[i]) ? freq[i] : -140;
          live.spectrum[i] += (v - live.spectrum[i]) * k;
        }
        live.frames++;
        if (live.frames > 45 && live.frames % 20 === 0) {
          live.cutoff = estimateBandwidth(
            live.spectrum,
            taps.context.sampleRate,
          );
          setCutoff(live.cutoff);
        }
      }
      drawSpectrum(taps.context.sampleRate);
    };

    void loadDevice().then(() => {
      if (!disposed) slowTick();
    });
    raf = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      pitchShifter.detachQualityMonitor();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const source = snapshot?.source ?? null;
  const engine = snapshot?.engine ?? null;
  const device = snapshot?.device ?? null;
  const format = device?.format ?? null;
  const codecName = source?.codec ? source.codec.toUpperCase() : "";

  const originLabel = source ? t(`audio_quality.origin.${source.origin}`) : "—";
  const sourceMain = !snapshot
    ? "—"
    : !source
      ? currentTrack
        ? t("audio_quality.probing")
        : "—"
      : [source.sampleRate ? formatRate(source.sampleRate) : "", codecName]
          .filter(Boolean)
          .join(" · ") || t("audio_quality.probing");
  const sourceSub = !currentTrack
    ? t("audio_quality.nothing_playing")
    : source
      ? source.lossless
        ? t("audio_quality.lossless")
        : t("audio_quality.lossy")
      : t("audio_quality.probing");

  const resampling =
    !engine || !source?.sampleRate
      ? "—"
      : source.sampleRate === engine.sampleRate
        ? t("audio_quality.none")
        : `${formatRate(source.sampleRate)} → ${formatRate(engine.sampleRate)}`;

  const speedLabel =
    Math.abs(playbackRate - 1) < 0.001
      ? "1.00×"
      : `${playbackRate.toFixed(2)}× · ${
          isPitchLinked
            ? t("audio_quality.speed_resampled")
            : t("audio_quality.speed_stretched")
        }`;

  const deviceDepth = format
    ? format.float
      ? t("audio_quality.float_bits", { bits: 32 })
      : format.validBits === format.containerBits
        ? t("audio_quality.int_bits", { bits: format.validBits })
        : t("audio_quality.int_bits_in", {
            bits: format.validBits,
            container: format.containerBits,
          })
    : "";

  const pitchActive = !isPitchLinked && Math.abs(pitchSemitones) >= 0.05;
  const eqActive = isEqActive(isEqEnabled, eqGains);
  const chips: Array<{ text: string; tone?: "warn" | "ok" }> = [];
  if (volume < 0.999)
    chips.push({
      text: t("audio_quality.chip.volume", { db: toDb(volume).toFixed(1) }),
    });
  if (eqActive) {
    chips.push({ text: t("audio_quality.chip.eq") });
    const preamp = eqPreampDb(eqGains);
    if (Math.abs(preamp) > 0.05)
      chips.push({
        text: t("audio_quality.chip.preamp", { db: preamp.toFixed(1) }),
      });
  }
  if (pitchActive)
    chips.push({
      text: t("audio_quality.chip.pitch", {
        semitones: `${pitchSemitones > 0 ? "+" : ""}${pitchSemitones.toFixed(1)}`,
      }),
    });
  if (isReverbEnabled && reverbLevel > 0.01)
    chips.push({
      text: t("audio_quality.chip.reverb", {
        level: Math.round(reverbLevel * 100),
      }),
    });
  if (Math.abs(playbackRate - 1) >= 0.001)
    chips.push({
      text: t("audio_quality.chip.speed", { rate: playbackRate.toFixed(2) }),
    });
  if (engine && source?.sampleRate && source.sampleRate !== engine.sampleRate)
    chips.push({
      text: t("audio_quality.chip.resampler", {
        from: formatRate(source.sampleRate),
        to: formatRate(engine.sampleRate),
      }),
      tone: "warn",
    });
  if (engine && format && format.sampleRate !== engine.sampleRate)
    chips.push({
      text: t("audio_quality.chip.windows_resampler", {
        from: formatRate(engine.sampleRate),
        to: formatRate(format.sampleRate),
      }),
      tone: "warn",
    });
  if (chips.length === 0)
    chips.push({ text: t("audio_quality.chip.clean"), tone: "ok" });

  const verdict =
    engine && cutoff
      ? bandwidthVerdict(
          cutoff,
          Math.min(source?.sampleRate ?? Infinity, engine.sampleRate),
        )
      : null;

  const meterRow = (
    side: "L" | "R",
    rms: React.RefObject<HTMLDivElement | null>,
    peak: React.RefObject<HTMLDivElement | null>,
    num: React.RefObject<HTMLSpanElement | null>,
  ) => (
    <div className="flex items-center gap-[10px]">
      <span
        className="w-[10px] text-[11px] font-[600] text-text-tertiary"
        style={font}
      >
        {side}
      </span>
      <div className="relative h-[8px] flex-1 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.1]">
        <div
          ref={rms}
          className="absolute inset-y-0 left-0 w-0 rounded-full bg-text-primary/60"
        />
        <div
          ref={peak}
          className="absolute inset-y-0 left-0 w-[2px] bg-accent-primary"
        />
      </div>
      <span
        ref={num}
        className="w-[38px] text-right text-[12px] tabular-nums text-text-secondary"
        style={font}
      >
        —
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-[16px] px-[20px] pb-[20px]">
      <DialogHeader
        title={t("audio_quality.title")}
        description={
          currentTrack
            ? [currentTrack.artists, currentTrack.title]
                .filter(Boolean)
                .join(" — ")
            : t("audio_quality.nothing_playing")
        }
      />

      <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-3">
        <Stage
          title={t("audio_quality.source")}
          main={sourceMain}
          sub={sourceSub}
          rows={[
            [
              t("audio_quality.codec"),
              source?.codec
                ? [
                    codecName,
                    source.profile,
                    source.container &&
                    source.container.toUpperCase() !== codecName
                      ? `· ${source.container}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")
                : "—",
            ],
            [
              t("audio_quality.bit_depth"),
              !source?.codec
                ? "—"
                : source.lossless
                  ? source.bitDepth
                    ? t("audio_quality.int_bits", { bits: source.bitDepth })
                    : "—"
                  : t("audio_quality.lossy_depth"),
            ],
            [t("audio_quality.bitrate"), formatKbps(source?.bitrate)],
            [
              t("audio_quality.channels"),
              source?.channels ? String(source.channels) : "—",
            ],
            [t("audio_quality.from"), originLabel],
          ]}
        />
        <Stage
          title={t("audio_quality.engine")}
          main={
            engine
              ? `${t("audio_quality.float_bits", { bits: 32 })} · ${formatRate(engine.sampleRate)}`
              : "—"
          }
          sub={
            engine
              ? t("audio_quality.engine_sub")
              : t("audio_quality.engine_idle")
          }
          rows={[
            [t("audio_quality.resampling"), resampling],
            [t("audio_quality.speed"), speedLabel],
            [
              t("audio_quality.latency"),
              engine?.latencyMs ? `${engine.latencyMs.toFixed(1)} ms` : "—",
            ],
            [
              t("audio_quality.buffered"),
              snapshot?.bufferedSec != null
                ? `${snapshot.bufferedSec.toFixed(1)} s`
                : "—",
            ],
            [
              t("audio_quality.state"),
              engine ? t(`audio_quality.ctx.${engine.state}`) : "—",
            ],
          ]}
        />
        <Stage
          title={t("audio_quality.output")}
          main={
            format
              ? `${deviceDepth} · ${formatRate(format.sampleRate)}`
              : engine
                ? formatRate(engine.sampleRate)
                : "—"
          }
          sub={
            format
              ? engine && engine.sampleRate !== format.sampleRate
                ? t("audio_quality.device_resamples", {
                    from: formatRate(engine.sampleRate),
                    to: formatRate(format.sampleRate),
                  })
                : t("audio_quality.device_format_note")
              : snapshot && !snapshot.endpointsSupported
                ? t("audio_quality.device_unsupported")
                : t("audio_quality.device_unknown")
          }
          rows={[
            [
              t("audio_quality.device"),
              snapshot?.deviceLabel || t("audio_quality.system_default"),
            ],
            [
              t("audio_quality.mixer"),
              navigator.userAgent.includes("Windows")
                ? t("audio_quality.mixer_wasapi")
                : t("audio_quality.mixer_os"),
            ],
            [
              t("audio_quality.channels"),
              format
                ? String(format.channels)
                : engine
                  ? String(engine.channels)
                  : "—",
            ],
          ]}
        />
      </div>

      <div className="flex flex-col gap-[8px]">
        <span
          className="text-[12px] font-[500] text-text-tertiary"
          style={font}
        >
          {t("audio_quality.processing")}
        </span>
        <div className="flex flex-wrap gap-[6px]">
          {chips.map((chip) => (
            <span
              key={chip.text}
              className={cn(
                "rounded-[8px] px-[9px] py-[4px] text-[12px] font-[500]",
                chip.tone === "warn"
                  ? "bg-accent-warning/15 text-accent-warning"
                  : chip.tone === "ok"
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "bg-black/[0.05] text-text-secondary dark:bg-white/[0.09]",
              )}
              style={font}
            >
              {chip.text}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-[10px] rounded-[12px] bg-black/[0.04] p-[14px] dark:bg-white/[0.08]">
        <div className="flex items-center justify-between gap-[10px]">
          <span
            className="text-[12px] font-[500] text-text-tertiary"
            style={font}
          >
            {t("audio_quality.live")}
          </span>
          <span
            className="text-[12px] tabular-nums text-text-tertiary"
            style={font}
          >
            {t("audio_quality.peak_hold")} {dbText(stats.peakHold)} ·{" "}
            {t("audio_quality.clips", { count: stats.clips })}
          </span>
        </div>
        {meterRow("L", meterRefs.lRms, meterRefs.lPeak, meterRefs.lNum)}
        {meterRow("R", meterRefs.rRms, meterRefs.rPeak, meterRefs.rNum)}
        <canvas ref={canvasRef} className="h-[120px] w-full" />
        <span className="text-[12px] text-text-secondary" style={font}>
          {!snapshot?.playing
            ? t("audio_quality.paused")
            : cutoff && verdict
              ? t("audio_quality.bandwidth", {
                  khz: (cutoff / 1000).toFixed(1),
                  verdict: t(`audio_quality.verdict.${verdict}`),
                })
              : t("audio_quality.measuring")}
        </span>
      </div>
    </div>
  );
}

export function AudioQualityDialog() {
  const open = useAudioQualityStore((s) => s.open);
  const setOpen = useAudioQualityStore((s) => s.setOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen} maxWidth={720}>
      {open ? <AudioQualityPanel /> : null}
    </Dialog>
  );
}
