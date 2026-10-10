import { describe, expect, it } from "vitest";
import { detectDeviceSwitch, deviceSwitchConfig } from "./deviceSwitch";

const day = (i: number) => new Date(Date.UTC(2026, 3, 8 + i)).toISOString().slice(0, 10);
/** Main sleeps on consecutive wake days, one source each. */
const nights = (sources: string[], start = 0) => sources.map((source, i) => ({ day: day(start + i), source }));
const run = (source: string, n: number) => Array<string>(n).fill(source);

describe("detectDeviceSwitch (scoring version 34)", () => {
  it("180 Health Connect nights then 7 Fitbit nights: the first Fitbit night's wake day", () => {
    expect(deviceSwitchConfig).toEqual({ minNewNights: 3, minOldNights: 7 });
    const ms = nights([...run("HEALTH_CONNECT", 180), ...run("FITBIT", 7)]);
    expect(detectDeviceSwitch(ms)).toEqual({ day: day(180), from: "HEALTH_CONNECT", to: "FITBIT" });
  });

  it("order doesn't matter", () => {
    const ms = nights([...run("HEALTH_CONNECT", 20), ...run("FITBIT", 4)]).reverse();
    expect(detectDeviceSwitch(ms)?.day).toBe(day(20));
  });

  it("fewer than 3 new nights is too early", () => {
    expect(detectDeviceSwitch(nights([...run("HEALTH_CONNECT", 20), ...run("FITBIT", 2)]))).toBeNull();
    expect(detectDeviceSwitch(nights([...run("HEALTH_CONNECT", 20), ...run("FITBIT", 3)]))?.day).toBe(day(20));
  });

  it("fewer than 7 old nights isn't worth starting over for", () => {
    expect(detectDeviceSwitch(nights([...run("HEALTH_CONNECT", 6), ...run("FITBIT", 5)]))).toBeNull();
    expect(detectDeviceSwitch(nights([...run("HEALTH_CONNECT", 7), ...run("FITBIT", 5)]))?.day).toBe(day(7));
  });

  it("one stray night from another source inside a run is not a switch", () => {
    const ms = nights([...run("FITBIT", 30), "HEALTH_CONNECT", ...run("FITBIT", 10)]);
    expect(detectDeviceSwitch(ms)).toBeNull();
  });

  it("a stray third-source night inside the old run doesn't hide the switch", () => {
    const ms = nights([...run("HEALTH_CONNECT", 10), "google", ...run("HEALTH_CONNECT", 5), ...run("FITBIT", 4)]);
    expect(detectDeviceSwitch(ms)).toEqual({ day: day(16), from: "HEALTH_CONNECT", to: "FITBIT" });
  });

  it("switching back gives the latest switch", () => {
    const ms = nights([...run("HEALTH_CONNECT", 10), ...run("FITBIT", 10), ...run("HEALTH_CONNECT", 4)]);
    expect(detectDeviceSwitch(ms)).toEqual({ day: day(20), from: "FITBIT", to: "HEALTH_CONNECT" });
  });

  it("one source throughout, or nothing at all, is no switch", () => {
    expect(detectDeviceSwitch(nights(run("FITBIT", 60)))).toBeNull();
    expect(detectDeviceSwitch([])).toBeNull();
  });
});
