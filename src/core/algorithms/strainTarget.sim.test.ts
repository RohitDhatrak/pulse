// Strain Target's progression limit on simulated people (SCORING_VERSION 26; docs/algorithms/strain-target.md § Why
// version 26). 30 people per case: rest days log-normal around TRIMP 8, sessions ±20 %, Recovery 58, ACWR 1. The real
// strainTarget's typical session is compared with the session the person is really doing. Deterministic.
import { describe, expect, it } from "vitest";
import { loadToStrain as S } from "../scoring/load";
import { strainTarget } from "./strainTarget";

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
