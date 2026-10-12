// Strain Target's progression limit (SCORING_VERSION 26) and starter session (48) on simulated people
// (docs/algorithms/strain-target.md § Why version 26, 48). 30 people per case: rest days log-normal around TRIMP 8, sessions ±20 %, Recovery 58, ACWR 1. The real
// strainTarget's typical session is compared with the session the person is really doing. Deterministic.
import { describe, expect, it } from "vitest";
import { loadToStrain as S } from "../scoring/load";
import { strainTarget, strainTargetConfig } from "./strainTarget";

let s = 99;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648);
const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
const rest = () => Math.exp(Math.log(8) + 0.4 * g());
const days = (n: number, week: number[], session: number) => Array.from({ length: n }, (_, i) => (week.includes(i % 7) ? session * Math.exp(0.2 * g()) : rest()));
const restDays = (n: number) => Array.from({ length: n }, rest);
const FOUR = [0, 2, 4, 5];

type Case = { loads: number[]; truth: (d: number) => number | null; from: number; to: number };
/** Days per person the target's typical session sat more than 3 Strain points under the real one, and the largest day-to-day move. */
function run(build: () => Case) {
  let pinned = 0;
  let maxJump = 0;
  const bases: number[][] = [];
  for (let p = 0; p < 30; p++) {
    const c = build();
    let prev: number | null = null;
    const row: number[] = [];
    for (let d = c.from; d < c.to; d++) {
      const t = strainTarget({ priorLoad: c.loads.slice(0, d), priorRecovery: [], recovery: 58, acwr: 1 });
      const truth = c.truth(d);
      if (!t || truth == null) continue;
      row.push(t.base);
      if (t.base < S(truth) - 3) pinned++;
      if (prev != null) maxJump = Math.max(maxJump, Math.abs(t.base - prev));
      prev = t.base;
    }
    bases.push(row);
  }
  return { pinnedPerPerson: pinned / 30, maxJump, bases };
}

describe("after a low period the target follows the sessions (version 25: pinned near rest for weeks)", () => {
  it("a beginner: 70 sedentary days, then 3 sessions a week (version 25: 24 days pinned, a 5.9-point jump)", () => {
    const r = run(() => ({ loads: [...restDays(70), ...days(70, [0, 2, 4], 120)], truth: (d) => (d >= 80 ? 120 : null), from: 71, to: 140 }));
    expect(r.pinnedPerPerson).toBe(0);
    expect(r.maxJump).toBeLessThanOrEqual(1);
  });

  it.each([28, 42])("a %i-day break with the band on, back at the same level (version 25: 11 and 23 days pinned)", (brk) => {
    const r = run(() => ({
      loads: [...days(84, FOUR, 118), ...restDays(brk), ...days(63, FOUR, 118)],
      truth: (d) => (d >= 84 + brk + 10 ? 118 : null),
      from: 84 + brk + 1,
      to: 84 + brk + 63,
    }));
    expect(r.pinnedPerPerson).toBe(0);
    expect(r.maxJump).toBeLessThanOrEqual(1);
  });
});

describe("where version 25 was right, nothing changes", () => {
  it("a steady trainer and a weekend warrior track their session", () => {
    for (const [week, session] of [[FOUR, 118], [[5], 200]] as const) {
      const r = run(() => ({ loads: days(200, [...week], session), truth: () => session, from: 60, to: 200 }));
      expect(r.pinnedPerPerson).toBe(0);
      expect(r.maxJump).toBeLessThan(1);
    }
  });

  it("a sudden doubling (100 → 200) is still held to 1.1 × the earlier sessions for the first 4 weeks", () => {
    const r = run(() => ({ loads: [...days(84, FOUR, 100), ...days(84, FOUR, 200)], truth: () => 200, from: 98, to: 112 }));
    for (const row of r.bases) for (const b of row) expect(b).toBeLessThan(S(100 * 1.1 * 1.25));
  });
});

describe("a starter session (version 48: none, or a rest day, for people without training of their own)", () => {
  s = 48;
  const lowRest = () => Math.exp(Math.log(4) + 0.4 * g());
  const people = {
    neverZone1: () => Array<number>(98).fill(0),
    flecks: () => Array.from({ length: 98 }, () => (rnd() < 0.3 ? 3 * rnd() : 0)),
    everyOtherWeek: () => Array.from({ length: 98 }, (_, i) => (i % 14 === 3 ? 150 * Math.exp(0.2 * g()) : lowRest())),
    weekly: () => Array.from({ length: 98 }, (_, i) => (i % 7 === 3 ? 150 * Math.exp(0.2 * g()) : lowRest())),
    light3: () => days(98, [0, 2, 4], 40),
    three: () => days(98, [0, 2, 4], 80),
    four: () => days(98, FOUR, 118),
  };
  const loads = Object.fromEntries(Object.entries(people).map(([k, gen]) => [k, Array.from({ length: 30 }, gen)])) as Record<keyof typeof people, number[][]>;
  /** Every target from day 28 on, for each person; `starter` 0 is version 47. */
  const targets = (who: keyof typeof people, starter = strainTargetConfig.starterSession) => {
    const keep = strainTargetConfig.starterSession;
    strainTargetConfig.starterSession = starter;
    try {
      return loads[who].flatMap((l) => Array.from({ length: 70 }, (_, k) => strainTarget({ priorLoad: l.slice(0, 28 + k), priorRecovery: [], recovery: 58, acwr: 1 })));
    } finally {
      strainTargetConfig.starterSession = keep;
    }
  };
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

  it("never reaching zone 1: a starter target every day (version 47: none on any day)", () => {
    expect(targets("neverZone1", 0).every((t) => t == null)).toBe(true);
    const now = targets("neverZone1");
    expect(now.every((t) => t?.starter && t.acwrRule == null)).toBe(true);
    expect(median(now.map((t) => t!.high))).toBeCloseTo(S(strainTargetConfig.starterSession * strainTargetConfig.width), 10);
  });

  it("a few minutes of zone 1, or a session every other week: above rest level and never 'returning' (version 47: tops 4.6 and 4.9)", () => {
    for (const who of ["flecks", "everyOtherWeek"] as const) {
      expect(median(targets(who, 0).map((t) => t!.high)), who).toBeLessThan(5.5);
      const now = targets(who);
      expect(median(now.map((t) => t!.high)), who).toBeGreaterThan(8);
      expect(now.some((t) => t!.acwrRule === "returning"), who).toBe(false);
    }
  });

  it("weekly, light 3-a-week (40), 3-a-week and 4-a-week trainers are unchanged", () => {
    for (const who of ["weekly", "light3", "three", "four"] as const) {
      const now = targets(who);
      expect(now.some((t) => t!.starter), who).toBe(false);
      const range = (t: ReturnType<typeof strainTarget>) => t && [t.low, t.high, t.base, t.band, t.coldStart, t.acwrRule];
      expect(now.map(range), who).toEqual(targets(who, 0).map(range));
    }
  });

  it("a once-a-week beginner's jump when sessions take over is smaller (version 47: 7.2 points)", () => {
    const build = () => ({ loads: [...restDays(70), ...days(70, [3], 150)], truth: (d: number) => (d >= 80 ? 150 : null), from: 71, to: 140 });
    const keep = strainTargetConfig.starterSession;
    s = 480;
    strainTargetConfig.starterSession = 0;
    const before = run(build);
    strainTargetConfig.starterSession = keep;
    s = 480;
    const after = run(build);
    // Measured: 7.2 → 4.3.
    expect(before.maxJump).toBeGreaterThan(6);
    expect(after.maxJump).toBeLessThan(before.maxJump - 2);
  });

  it("someone who never reached zone 1 and does the middle of the range each day for 26 weeks stays near the starter", () => {
    // Measured ×1.05. Doing the top every day compounds (×4.7; a daily 118 trainer in version 47: ×3.1).
    const toLoad = (strain: number) => Math.pow(7201, strain / 21) - 1;
    const followed: number[] = Array(28).fill(0);
    let first: number | null = null;
    let last = 0;
    for (let d = 0; d < 182; d++) {
      const t = strainTarget({ priorLoad: followed, priorRecovery: [], recovery: 58 + 10 * g(), acwr: 1 })!;
      first ??= t.base;
      last = t.base;
      followed.push(toLoad((t.low + t.high) / 2));
    }
    const ratio = toLoad(last) / toLoad(first!);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.8);
  });
});
