import { execFile } from "node:child_process";

// the shared-mode mix format windows hands every app on a playback device: the
// AudioContext resamples to this rate, and this is what reaches the dac
export interface WaveFormat {
  channels: number;
  sampleRate: number;
  containerBits: number;
  validBits: number;
  float: boolean;
}

export interface OutputEndpoint {
  id: string;
  name: string;
  iface: string;
  label: string;
  format: WaveFormat | null;
}

export interface OutputEndpoints {
  supported: boolean;
  endpoints: OutputEndpoint[];
}

const RENDER_KEY =
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render";
const PKEY_NAME = "{a45c254e-df1c-4efd-8020-67d146a850e0},2";
const PKEY_IFACE = "{b3f8fa53-0004-438e-9003-51a46e139bfc},6";
const PKEY_FORMAT = "{f19f064d-082c-4e27-bc73-6882a1bb8e4c},0";
const CACHE_MS = 15_000;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

// registry value is a REG_BINARY hex string; PKEY blobs carry an 8-byte VT_BLOB header
export function decodeWaveFormat(hex: string | undefined): WaveFormat | null {
  const clean = String(hex ?? "").replace(/[^0-9a-f]/gi, "");
  if (clean.length < 36) return null;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2)
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  const offset =
    bytes[0] === 0x41 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0
      ? 8
      : 0;
  if (bytes.length < offset + 16) return null;
  const u16 = (i: number) => bytes[offset + i] | (bytes[offset + i + 1] << 8);
  const u32 = (i: number) =>
    (bytes[offset + i] |
      (bytes[offset + i + 1] << 8) |
      (bytes[offset + i + 2] << 16) |
      (bytes[offset + i + 3] << 24)) >>>
    0;
  const tag = u16(0);
  const channels = u16(2);
  const sampleRate = u32(4);
  const containerBits = u16(14);
  let validBits = containerBits;
  let float = tag === WAVE_FORMAT_IEEE_FLOAT;
  if (tag === WAVE_FORMAT_EXTENSIBLE && bytes.length >= offset + 28) {
    validBits = u16(18) || containerBits;
    float = u32(24) === WAVE_FORMAT_IEEE_FLOAT;
  }
  if (!channels || !sampleRate) return null;
  return { channels, sampleRate, containerBits, validBits, float };
}

export function parseRegQuery(
  stdout: string,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let key: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      key = line.trim();
      continue;
    }
    const match =
      line.match(/^\s+(.+?)\s{4}(REG_\w+)\s{4}(.*)$/) ??
      line.match(/^\s+(.+?)\s{4}(REG_\w+)$/);
    if (key && match) {
      out[key] ??= {};
      out[key][match[1]] = match[3] === undefined ? "" : match[3].trim();
    }
  }
  return out;
}

export function buildEndpointList(
  statesOut: string,
  propsOut: string,
): OutputEndpoint[] {
  const states = parseRegQuery(statesOut);
  const props = parseRegQuery(propsOut);
  const list: OutputEndpoint[] = [];
  for (const key of Object.keys(states)) {
    // DEVICE_STATE_ACTIVE
    if ((parseInt(states[key].DeviceState, 16) & 0xf) !== 1) continue;
    const p = props[`${key}\\Properties`] ?? {};
    const name = p[PKEY_NAME] ?? "";
    const iface = p[PKEY_IFACE] ?? "";
    list.push({
      id: key.split("\\").pop() ?? key,
      name,
      iface,
      label: iface ? `${name} (${iface})` : name,
      format: decodeWaveFormat(p[PKEY_FORMAT]),
    });
  }
  return list;
}

function regQuery(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", RENDER_KEY, ...args],
      { timeout: 3000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? "" : stdout),
    );
  });
}

let cache: { at: number; data: OutputEndpoints } | null = null;

export async function getOutputEndpoints(): Promise<OutputEndpoints> {
  if (process.platform !== "win32") return { supported: false, endpoints: [] };
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const [states, ...props] = await Promise.all([
    regQuery(["/s", "/v", "DeviceState"]),
    ...[PKEY_NAME, PKEY_IFACE, PKEY_FORMAT].map((value) =>
      regQuery(["/s", "/v", value]),
    ),
  ]);
  const data = {
    supported: true,
    endpoints: buildEndpointList(states, props.join("\n")),
  };
  cache = { at: Date.now(), data };
  return data;
}
