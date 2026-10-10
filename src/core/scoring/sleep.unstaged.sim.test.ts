// Sleep Performance on nights without stages (SCORING_VERSION 31; docs/algorithms/sleep-need.md § Why version 31).
// 200 simulated people per group, each with their own deep and REM shares and a history of 28 staged nights. Each
// test night is scored with its real stages (the truth) and as if unstaged; the gap is the error. Short, fragmented
// 3–4.5 h nights (the kind Fitbit often can't stage) are checked too. Deterministic.
import { describe, expect, it } from "vitest";
import { percentile } from "./strain";
import { rest, restorativeScore } from "./sleep";

let s = 11;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648);
const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

const GROUPS = [
  ["young (deep 17 %, REM 23 %)", 0.17, 0.23, 0.04],
  ["middle (deep 13 %, REM 21 %)", 0.13, 0.21, 0.04],
  ["older (deep 8 %, REM 18 %)", 0.08, 0.18, 0.035],
] as const;

/** Errors (estimate − staged truth) of the personal-median rule and of version 30's "deep and REM are 0". */
function errors(deep: number, rem: number, sd: number, short: boolean) {
  const usual: number[] = [];
  const old: number[] = [];
  for (let p = 0; p < 200; p++) {
    const myDeep = deep + sd * g();
    const myRem = rem + sd * g();
    const myH = 7.2 + 0.5 * g();
    const myEff = 0.88 + 0.03 * g();
    const night = (isShort: boolean) => {
      const asleep = (isShort ? 3 + 1.5 * rnd() : Math.max(4, myH + 0.6 * g())) * 3600;
      return {
        asleep,
        eff: clamp(isShort ? myEff - 0.12 + 0.05 * g() : myEff + 0.03 * g(), 0.4, 0.99),
        deep: clamp(myDeep + 0.03 * g(), 0.01, 0.35) * asleep,
        rem: clamp(myRem + 0.04 * g(), 0.03, 0.4) * asleep,
        cons: clamp(0.8 + 0.08 * g(), 0, 1),
      };
    };
    const history = Array.from({ length: 28 }, () => night(false)).map((n) => restorativeScore(n.deep, n.rem, n.asleep)).sort((a, b) => a - b);
    const usualRestorative = percentile(history, 50);
    for (let k = 0; k < 10; k++) {
      const n = night(short);
      const truth = rest(n.asleep, n.eff, n.deep, n.rem, 7.5, n.cons)!;
      usual.push(rest(n.asleep, n.eff, null, null, 7.5, n.cons, { usualRestorative })! - truth);
      old.push(rest(n.asleep, n.eff, 0, 0, 7.5, n.cons)! - truth);
    }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return { bias: mean(usual), mae: mean(usual.map(Math.abs)), oldBias: mean(old) };
}

describe("an unstaged night scored with your usual restorative sleep is close to what its stages would give", () => {
  for (const [name, deep, rem, sd] of GROUPS) {
    for (const short of [false, true]) {
      it(`${name}, ${short ? "short fragmented" : "ordinary"} nights: |bias| ≤ 1 and MAE ≤ 2.5 (version 30: bias ≤ −8)`, () => {
        const e = errors(deep, rem, sd, short);
        expect(Math.abs(e.bias)).toBeLessThanOrEqual(1);
        expect(e.mae).toBeLessThanOrEqual(2.5);
        expect(e.oldBias).toBeLessThanOrEqual(-8);
      });
    }
  }
});
