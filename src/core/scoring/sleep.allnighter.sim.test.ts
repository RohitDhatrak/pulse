// A night spent awake on simulated nights (SCORING_VERSION 25; docs/algorithms/sleep-need.md § A night spent awake).
// 00:00–06:00, minute by minute, through the real nightSummary and awakeAllNight. Assumptions: Google's resting HR
// is about the sleeping HR + 3; awake seated HR is 8–16 bpm over sleeping (4–8 for a low riser: beta-blockers, some
// older adults); half of sleeping nights have one bathroom trip of about 50 steps. Deterministic.
import { describe, expect, it } from "vitest";
import { awakeAllNight, ledger, nightSummary } from "./sleep";

let s = 4242;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648);
const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());

type Person = { sleepHr: number; rhr: number; still: number };
const person = (): Person => {
  const sleepHr = 50 + 8 * g();
  return { sleepHr, rhr: sleepHr + 3 + 1.5 * g(), still: 8 + 8 * rnd() };
};
type Night = { hr: number[]; steps: number[] };

/** Asleep all night: REM bumps, brief awakenings lying in bed (`wakeShare`), maybe one bathroom trip. */
function asleep(p: Person, shift: number, wakeShare: number): Night {
  const nightly = 2 * g();
  const hr: number[] = [];
  const steps: number[] = [];
  let awake = false;
  for (let m = 0; m < 360; m++) {
    if (rnd() < (awake ? 0.15 : wakeShare / 20)) awake = !awake;
    const rem = Math.sin((m / 90) * Math.PI * 2) > 0.6 ? 4 : 0;
    hr.push(p.sleepHr + shift + nightly + rem + (awake ? 6 + 4 * rnd() : 0) + 2.5 * g());
    steps.push(0);
  }
  if (rnd() < 0.5) {
    const t = Math.floor(rnd() * 330);
    for (let k = 0; k < 3; k++) {
      steps[t + k] = 15 + Math.floor(15 * rnd());
      hr[t + k] += 20;
    }
  }
  return { hr, steps };
}

/** Up all night: at a desk (an occasional trip to the kitchen), out and active, or with a small HR rise. */
function up(p: Person, kind: "desk" | "active" | "low"): Night {
  const nightly = 2 * g();
  const offset = kind === "low" ? 4 + 4 * rnd() : p.still;
  const hr: number[] = [];
  const steps: number[] = [];
  for (let m = 0; m < 360; m++) {
    let v = p.sleepHr + offset + nightly + 3 * g();
    let st = 0;
    if (kind === "active") {
      v += 15 + 10 * rnd();
      st = rnd() < 0.5 ? Math.floor(40 + 60 * rnd()) : 0;
    } else if (rnd() < 0.02) {
      st = Math.floor(20 + 60 * rnd());
      v += 12;
    }
    hr.push(v);
    steps.push(st);
  }
  return { hr, steps };
}

const N = 1000;
const share = (make: (p: Person) => Night) => {
  let hit = 0;
  for (let i = 0; i < N; i++) {
    const p = person();
    const n = make(p);
    if (awakeAllNight({ night: nightSummary(n.hr, n.steps), restingHr: p.rhr, sessionOverlapsNight: false })) hit++;
  }
  return hit / N;
};

describe("telling a night spent awake from a night without a session (simulated)", () => {
  it.each([
    ["ordinary", 0, 0.05],
    ["after alcohol (+6 bpm)", 6, 0.1],
    ["sick (+8 bpm)", 8, 0.15],
    ["a high fever (+12 bpm)", 12, 0.2],
    ["insomnia (about 40 % awake in bed)", 0, 0.6],
  ] as const)("no sleeping night passes, %s: a missed or unsynced session never becomes an all-nighter", (_, shift, wakeShare) => {
    expect(share((p) => asleep(p, shift, wakeShare))).toBe(0);
  });

  it("at least 80 % of nights awake at a desk, and every active one, are found", () => {
    expect(share((p) => up(p, "desk"))).toBeGreaterThanOrEqual(0.8);
    expect(share((p) => up(p, "active"))).toBe(1);
  });

  it("a small HR rise is mostly missed: those nights stay unknown, as before version 25", () => {
    const low = share((p) => up(p, "low"));
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(0.5);
  });

  it("a found all-nighter costs more debt than a 1 h night", () => {
    const debt = (slept: number) => ledger([["2026-06-01", 450], ["2026-06-02", slept]], 7.5).magnitudeMin;
    expect(debt(0)).toBeGreaterThan(debt(60));
  });
});
