import { describe, expect, it } from "vitest";
import { buildEndpointList, decodeWaveFormat } from "./endpoints";

const BASE =
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render";

describe("decodeWaveFormat", () => {
  it("reads an extensible 24-bit in 32 PCM mix format", () => {
    expect(
      decodeWaveFormat(
        "4100000001000000FEFF020080BB000000DC05000800200016001800030000000100000000001000800000AA00389B71",
      ),
    ).toEqual({
      channels: 2,
      sampleRate: 48000,
      containerBits: 32,
      validBits: 24,
      float: false,
    });
  });

  it("reads the float subformat", () => {
    const format = decodeWaveFormat(
      "4100000001000000FEFF020080BB000000DC05000800200016002000030000000300000000001000800000AA00389B71",
    );
    expect(format?.float).toBe(true);
    expect(format?.validBits).toBe(32);
  });

  it("ignores blobs that are too short", () => {
    expect(decodeWaveFormat("41000000")).toBeNull();
    expect(decodeWaveFormat(undefined)).toBeNull();
  });
});

describe("buildEndpointList", () => {
  it("keeps only active devices and labels them like chromium", () => {
    const states = `${BASE}\\{a}\r\n    DeviceState    REG_DWORD    0x1\r\n\r\n${BASE}\\{b}\r\n    DeviceState    REG_DWORD    0x4\r\n`;
    const props = [
      `${BASE}\\{a}\\Properties\r\n    {a45c254e-df1c-4efd-8020-67d146a850e0},2    REG_SZ    Speakers\r\n`,
      `${BASE}\\{a}\\Properties\r\n    {b3f8fa53-0004-438e-9003-51a46e139bfc},6    REG_SZ    Realtek(R) Audio\r\n`,
      `${BASE}\\{a}\\Properties\r\n    {f19f064d-082c-4e27-bc73-6882a1bb8e4c},0    REG_BINARY    4100000001000000FEFF0200803E0000007D00000400100016001000030000000100000000001000800000AA00389B71\r\n`,
    ].join("\n");
    const list = buildEndpointList(states, props);
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("Speakers (Realtek(R) Audio)");
    expect(list[0].format?.sampleRate).toBe(16000);
  });
});
