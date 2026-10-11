// Which days the SRI counts, on simulated wearers (SCORING_VERSION 44, audit S9; docs/algorithms/sleep-regularity.md
// § Why version 44). Each person sleeps about 8 h a night for 60 nights; the band is worn all day (about 1,380 minutes
// with heart rate per noon-to-noon period) or only in bed (the night's length plus 20 minutes). Version 43's rule (a period
// is covered at 720+ heart-rate minutes) is kept as a reference. Sleep Performance holds every other term fixed, so it
// moves only through consistency. 40 people per case. Deterministic.
import { describe, expect, it } from "vitest";
import { rest } from "../scoring/sleep";
import { nightCovered, sleepRegularityIndex, sriConsistency, sriDisplay } from "./sleepRegularity";

function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(Math.max(u(), 1e-12))) * Math.cos(2 * Math.PI * u());
}

const H = 3600;
const DAY = 24 * H;
const T0 = 1_790_000_000 - (1_790_000_000 % DAY); // a UTC midnight: day i's noon is T0 + i·DAY + 12 h
const noon = (i: number) => T0 + i * DAY + 12 * H;

type Night = { start: number; end: number } | null;
type Case = { nights: Night[]; awake: boolean[]; hrMin: number[] };
/** Nights i = 0…59 (the night ending on wake day i + 1, in period i). `bedSd` hours of bedtime spread; 0 is an identical schedule, length included. */
function person(seed: number, bedSd: number, wear: "allDay" | "nightOnly", missed: number[] = [], allNighters: number[] = []): Case {
  const g = rng(seed);
  const own = 23 + 0.3 * g();
  const nights: Night[] = [];
  const awake: boolean[] = [];
  const hrMin: number[] = [];
  for (let i = 0; i < 60; i++) {
    const bed = noon(i) + (own - 12 + bedSd * g()) * H;
    const len = (8 + (bedSd > 0 ? 0.4 : 0) * g()) * H;
    const slept = !missed.includes(i) && !allNighters.includes(i);
    nights.push(slept ? { start: bed, end: bed + len } : null);
    awake.push(allNighters.includes(i));
    // A missed night: worn, but no sleep was detected and it didn't read as awake (the band lost it).
    hrMin.push(wear === "allDay" ? 1380 : slept ? len / 60 + 20 : allNighters.includes(i) ? 600 : 0);
  }
  return { nights, awake, hrMin };
}

/** The SRI on each wake day D = 7…60 (periods D − 7 … D − 1), under version 43's coverage or version 44's. */
function sris(c: Case, v43 = false): (number | null)[] {
  const mains = c.nights.filter((n): n is NonNullable<Night> => n != null);
  const out: (number | null)[] = [];
  for (let d = 7; d <= 60; d++) {
    const covered = Array.from({ length: 7 }, (_, k) => {
      const i = d - 7 + k;
      return v43 ? c.hrMin[i] >= 720 : nightCovered(noon(i), noon(i + 1), mains, c.awake[i]);
    });
    out.push(sleepRegularityIndex(mains, noon(d - 7), covered));
  }
  return out;
}
/** Sleep Performance for a fixed 7.5 h night at 90 % efficiency, with this SRI. */
const perf = (sri: number | null) => rest(7.5 * H, 0.9, 1.1 * H, 1.6 * H, 7.5, sriConsistency(sri))!;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const people = (bedSd: number, wear: "allDay" | "nightOnly", seed: number, missed: number[] = [], allNighters: number[] = []) =>
  Array.from({ length: 40 }, (_, k) => person(seed * 100 + k, bedSd, wear, missed, allNighters));

describe("night-only wearers get an SRI (audit S9)", () => {
  const regularNight = people(20 / 60, "nightOnly", 1);
  const regularDay = people(20 / 60, "allDay", 1);

  it("a regular night-only wearer has an SRI every day (version 43: never), as the same person wearing it all day", () => {
    for (const c of regularNight) expect(sris(c, true).every((x) => x == null)).toBe(true);
    for (const c of regularNight) expect(sris(c).every((x) => x != null)).toBe(true);
    const gap = regularNight.map((c, k) => mean(sris(c).map((x, i) => Math.abs(x! - sris(regularDay[k])[i]!))));
    expect(Math.max(...gap)).toBe(0); // the same nights: the day's wear no longer matters
    expect(mean(regularNight.flatMap((c) => sris(c) as number[]))).toBeGreaterThan(85); // 92
  });

  it("an irregular sleeper no longer gains by taking the band off in the day (version 43: 0.5 instead of a low SRI)", () => {
    const night = people(3.5, "nightOnly", 2);
    const day = people(3.5, "allDay", 2);
    const sriAll = day.flatMap((c) => sris(c) as number[]);
    expect(mean(sriAll.map(sriDisplay))).toBeLessThan(50); // 40
    const before = mean(night.flatMap((c) => sris(c, true).map(perf)));
    const now = mean(night.flatMap((c) => sris(c).map(perf)));
    const worn = mean(day.flatMap((c) => sris(c).map(perf)));
    expect(before - worn).toBeGreaterThan(0.5); // 87.4 vs 86.4 (at SRI 0 the audit measured 5 points)
    expect(now).toBeCloseTo(worn, 9);
  });
});

describe("which nights count", () => {
  it("a night the band missed is skipped, not read as a night awake (version 43: about 78 the week after)", () => {
    // Bedtime spread 0: the same schedule every night, so a perfect week is 100.
    const c = person(5, 0, "allDay", [30]);
    const week = (xs: (number | null)[]) => xs.slice(30 - 7 + 1, 30 - 7 + 8); // wake days 31…37: the windows holding night 30
    expect(Math.min(...(week(sris(c, true)) as number[]))).toBeLessThan(80); // 77.8
    for (const x of week(sris(c))) expect(x).toBeCloseTo(100, 9);
  });

  it("a night spent awake still counts, as before", () => {
    const c = person(6, 0, "allDay", [], [30]);
    const before = sris(c, true);
    const now = sris(c);
    for (let i = 0; i < now.length; i++) expect(now[i]).toBeCloseTo(before[i]!, 9);
    expect(Math.min(...(now as number[]))).toBeLessThan(90);
  });
});
