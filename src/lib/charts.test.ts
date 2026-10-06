import { describe, expect, it } from "vitest";
import { clockTicks, hourTicks, hypnogramSeries, markerSlices, ringRadii, bandStops, targetSlices } from "./charts";

describe("bandStops", () => {
  const bands = [
    { from: 0, color: "red" },
    { from: 34, color: "yellow" },
    { from: 67, color: "green" },
  ];
  it("switches colour hard at each threshold inside the span", () => {
    expect(bandStops(100, 0, bands)).toEqual([
      { offset: 0, color: "green" },
      { offset: 0.33, color: "green" },
      { offset: 0.33, color: "yellow" },
      { offset: 0.66, color: "yellow" },
      { offset: 0.66, color: "red" },
      { offset: 1, color: "red" },
    ]);
  });
  it("skips thresholds outside the span", () => {
    expect(bandStops(60, 40, bands)).toEqual([
      { offset: 0, color: "yellow" },
      { offset: 1, color: "yellow" },
    ]);
  });
});

describe("hypnogramSeries", () => {
  const segs = [
    { stage: "light" as const, start: 0, end: 10 },
    { stage: "rem" as const, start: 10, end: 20 },
    { stage: "deep" as const, start: 20, end: 30 },
    { stage: "rem" as const, start: 30, end: 40 },
  ];
  it("runs the connector through every start and ends at wake", () => {
    expect(hypnogramSeries(segs).connector).toEqual([
      { t: 0, lane: 1 },
      { t: 10, lane: 2 },
      { t: 20, lane: 0 },
      { t: 30, lane: 2 },
      { t: 40, lane: 2 },
    ]);
  });
  it("never joins two separate blocks of one stage", () => {
    expect(hypnogramSeries(segs).stages.rem).toEqual([
      { t: 10, lane: 2 },
      { t: 20, lane: 2 },
      { t: 20, lane: null },
      { t: 30, lane: 2 },
      { t: 40, lane: 2 },
      { t: 40, lane: null },
    ]);
  });
  it("sorts unordered input", () => {
    expect(hypnogramSeries([...segs].reverse()).connector[0]).toEqual({ t: 0, lane: 1 });
  });
});

describe("hourTicks", () => {
  it("lands on whole local hours in a half-hour zone", () => {
    const bed = Date.UTC(2026, 9, 1, 17, 18); // 22:48 IST
    const wake = Date.UTC(2026, 9, 2, 1, 11); // 06:41 IST
    const ticks = hourTicks(bed, wake, 2, "Asia/Kolkata");
    const fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Kolkata" });
    expect(ticks.map((t) => fmt.format(t))).toEqual(["00:00", "02:00", "04:00", "06:00"]);
  });
  it("steps in minutes for short windows", () => {
    const start = Date.UTC(2026, 9, 2, 5, 46, 20); // 11:16:20 IST
    const fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Kolkata" });
    expect(clockTicks(start, start + 58 * 60_000, 15, "Asia/Kolkata").map((t) => fmt.format(t))).toEqual(["11:30", "11:45", "12:00"]);
  });
});

describe("ScoreDial slices", () => {
  it("strain target band covers lo to hi on 0-21", () => {
    expect(targetSlices(12, 15)).toEqual([12, 3, 6]);
    expect(targetSlices(19, 25)).toEqual([19, 2, 0]);
  });
  it("marker slices centre on the value and stay in the domain", () => {
    expect(markerSlices(13.5, 21, 0.2).map((v) => +v.toFixed(2))).toEqual([13.4, 0.2, 7.4]);
    expect(markerSlices(0, 3, 0.06).map((v) => +v.toFixed(2))).toEqual([0, 0.06, 2.94]);
  });
  it("ring radii leave 2 px for the tick", () => {
    expect(ringRadii(96, 6)).toEqual({ outer: "95.8%", inner: "83.3%", tickOuter: "100%", tickInner: "79.2%", hole: "8.3%" });
  });
});
