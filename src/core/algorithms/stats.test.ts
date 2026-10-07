import { describe, expect, it } from "vitest";
import { benjaminiHochberg, incompleteBeta, lnGamma, studentTQuantile, studentTTwoSidedP, welchDf } from "./stats";

describe("lnGamma", () => {
  it("matches factorials and Γ(½) = √π", () => {
    expect(lnGamma(1)).toBeCloseTo(0, 12);
    expect(lnGamma(5)).toBeCloseTo(Math.log(24), 12);
    expect(lnGamma(10)).toBeCloseTo(Math.log(362880), 10);
    expect(lnGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
    expect(lnGamma(0.25)).toBeCloseTo(Math.log(3.625609908221908), 10);
  });
});

describe("incompleteBeta", () => {
  it("has its closed forms and bounds", () => {
    expect(incompleteBeta(0, 2, 3)).toBe(0);
    expect(incompleteBeta(1, 2, 3)).toBe(1);
    // I_x(1, 1) = x; I_x(a, 1) = x^a; I_x(1, b) = 1 − (1 − x)^b.
    expect(incompleteBeta(0.3, 1, 1)).toBeCloseTo(0.3, 12);
    expect(incompleteBeta(0.6, 3, 1)).toBeCloseTo(0.216, 12);
    expect(incompleteBeta(0.2, 1, 4)).toBeCloseTo(1 - 0.8 ** 4, 12);
  });
  it("is symmetric: I_x(a, b) = 1 − I_(1−x)(b, a), on both sides of the switch point", () => {
    for (const x of [0.05, 0.3, 0.5, 0.7, 0.95]) expect(incompleteBeta(x, 2.5, 7)).toBeCloseTo(1 - incompleteBeta(1 - x, 7, 2.5), 12);
  });
});

describe("Student's t", () => {
  // Two-sided critical values from standard t tables.
  it.each([
    [0.1, 1, 6.314],
    [0.1, 4, 2.132],
    [0.1, 10, 1.812],
    [0.1, 30, 1.697],
    [0.05, 10, 2.228],
    [0.05, 5, 2.571],
    [0.01, 20, 2.845],
  ])("the two-sided %s critical value at df %s is %s", (p, df, t) => {
    expect(studentTQuantile(p, df)).toBeCloseTo(t, 3);
    expect(studentTTwoSidedP(t, df)).toBeCloseTo(p, 3);
  });
  it("tends to the normal as df grows", () => {
    expect(studentTQuantile(0.1, 1e6)).toBeCloseTo(1.6449, 3);
    expect(studentTTwoSidedP(1.96, 1e6)).toBeCloseTo(0.05, 3);
  });
  it("p is 1 at t = 0, symmetric in t, falls with |t|, and 0 for infinite t", () => {
    expect(studentTTwoSidedP(0, 7)).toBeCloseTo(1, 12);
    expect(studentTTwoSidedP(-2, 7)).toBeCloseTo(studentTTwoSidedP(2, 7), 14);
    expect(studentTTwoSidedP(3, 7)).toBeLessThan(studentTTwoSidedP(2, 7));
    expect(studentTTwoSidedP(Infinity, 7)).toBe(0);
  });
  it("works for Welch's fractional df", () => {
    const q = studentTQuantile(0.1, 7.5);
    expect(q).toBeGreaterThan(1.86); // df 8: 1.860
    expect(q).toBeLessThan(1.895); // df 7: 1.895
  });
});

describe("welchDf", () => {
  it("matches the Welch–Satterthwaite worked example", () => {
    // s1² = 4, n1 = 10; s2² = 9, n2 = 15 → v1 = 0.4, v2 = 0.6, df = 1 / (0.16/9 + 0.36/14) ≈ 22.98.
    expect(welchDf(0.4, 10, 0.6, 15)).toBeCloseTo(1 / (0.16 / 9 + 0.36 / 14), 10);
  });
  it("equal variances and sizes give n1 + n2 − 2", () => {
    expect(welchDf(0.5, 10, 0.5, 10)).toBeCloseTo(18, 10);
  });
  it("is the smaller arm's n − 1 when only that arm varies", () => {
    expect(welchDf(0.5, 6, 0, 40)).toBeCloseTo(5, 10);
  });
  it("falls back to n1 + n2 − 2 with no variance", () => {
    expect(welchDf(0, 6, 0, 8)).toBe(12);
  });
});

describe("benjaminiHochberg", () => {
  it("finds the largest k with p(k) ≤ k/m × q and keeps every p ranked at or below it", () => {
    // m = 5, q = 0.1: thresholds 0.02, 0.04, 0.06, 0.08, 0.10. Sorted p: 0.01 ✓, 0.03 ✓, 0.07 ✗, 0.075 ✓ (k = 4), 0.5 ✗.
    // 0.07 is above its own threshold but ranked below k = 4, so it is a discovery too.
    expect(benjaminiHochberg([0.5, 0.07, 0.01, 0.075, 0.03], 0.1)).toEqual([false, true, true, true, true]);
  });
  it("is stricter than per-test 0.1 when nothing is strong", () => {
    // Nine tests, one at p = 0.04: 0.04 > 0.1 / 9.
    const ps = [0.04, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99];
    expect(benjaminiHochberg(ps, 0.1).filter(Boolean)).toHaveLength(0);
    // Beside two strong effects it still doesn't: ranked third, it needs ≤ 3/9 × 0.1 = 0.033.
    expect(benjaminiHochberg([0.04, 0.001, 0.002, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99], 0.1)).toEqual([false, true, true, false, false, false, false, false, false]);
    // With three strong ones it does: 0.04 ≤ 4/9 × 0.1 = 0.044.
    expect(benjaminiHochberg([0.04, 0.001, 0.002, 0.003, 0.7, 0.8, 0.9, 0.95, 0.99], 0.1)).toEqual([true, true, true, true, false, false, false, false, false]);
  });
  it("one test is a discovery exactly when p ≤ q", () => {
    expect(benjaminiHochberg([0.1], 0.1)).toEqual([true]);
    expect(benjaminiHochberg([0.1001], 0.1)).toEqual([false]);
  });
  it("handles empty input, ties and non-finite p", () => {
    expect(benjaminiHochberg([], 0.1)).toEqual([]);
    expect(benjaminiHochberg([0.02, 0.02, 0.02], 0.05)).toEqual([true, true, true]);
    // NaN is never a discovery and does not count towards m.
    expect(benjaminiHochberg([0.04, NaN], 0.05)).toEqual([true, false]);
  });
});
