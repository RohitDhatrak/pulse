import { describe, expect, it } from "vitest";
import { FRIEND_PERCENTILES, FRIEND_TREADMILL, fitnessCategory, fitnessLevel, friendRowAt, referenceVo2max, type Sex, vo2maxPercentile } from "./fitnessLevel";

describe("vo2maxPercentile (FRIEND 2015 Table 2)", () => {
  it("returns the published percentile at decade midpoints, where each row applies exactly (version 49)", () => {
    expect(vo2maxPercentile(48.0, 25, "male")).toBeCloseTo(50, 10);
    expect(vo2maxPercentile(49.2, 35, "male")).toBeCloseTo(75, 10);
    expect(vo2maxPercentile(31.9, 45, "male")).toBeCloseTo(25, 10);
    expect(vo2maxPercentile(16.3, 75, "male")).toBeCloseTo(5, 10);
    expect(vo2maxPercentile(51.3, 25, "female")).toBeCloseTo(90, 10);
    expect(vo2maxPercentile(23.4, 55, "female")).toBeCloseTo(50, 10);
    expect(vo2maxPercentile(23.8, 65, "female")).toBeCloseTo(75, 10);
  });

  it("between midpoints it reads a row between the decades' rows (version 48: the decade's row, flat to its end)", () => {
    // A man of 49: 40 % of the way from the 40s' row to the 50s'. The 25th column is 31.9 + 0.4 × (27.1 − 31.9) = 29.98.
    expect(vo2maxPercentile(31.9 + 0.4 * (27.1 - 31.9), 49, "male")).toBeCloseTo(25, 10);
    expect(vo2maxPercentile(31.9, 49, "male")).toBeGreaterThan(25); // version 48: exactly 25
  });

  it("interpolates linearly between published columns", () => {
    expect(vo2maxPercentile((48.0 + 55.2) / 2, 25, "male")).toBeCloseTo(62.5, 10);
    expect(vo2maxPercentile(30.2 + (36.1 - 30.2) * 0.2, 35, "female")).toBeCloseTo(55, 10);
  });

  it("clamps to [5, 95]; under 25 is the 20s' row", () => {
    expect(vo2maxPercentile(10, 30, "male")).toBeCloseTo(5, 10);
    expect(vo2maxPercentile(90, 30, "male")).toBeCloseTo(95, 10);
    expect(vo2maxPercentile(48.0, 18, "male")).toBeCloseTo(50, 10);
    expect(vo2maxPercentile(48.0, 25, "male")).toBe(vo2maxPercentile(48.0, 13, "male"));
  });

  it("every published row increases", () => {
    for (const rows of Object.values(FRIEND_TREADMILL))
      for (const row of rows) for (let i = 1; i < row.length; i++) expect(row[i]).toBeGreaterThan(row[i - 1]);
  });
});

describe("fitnessCategory", () => {
  it("cuts at 20 / 40 / 60 / 80", () => {
    expect(fitnessCategory(19.99)).toBe("poor");
    expect(fitnessCategory(20)).toBe("fair");
    expect(fitnessCategory(39.99)).toBe("fair");
    expect(fitnessCategory(40)).toBe("good");
    expect(fitnessCategory(59.99)).toBe("good");
    expect(fitnessCategory(60)).toBe("excellent");
    expect(fitnessCategory(79.99)).toBe("excellent");
    expect(fitnessCategory(80)).toBe("superior");
  });

  it("fitnessLevel combines both", () => {
    expect(fitnessLevel(49.2, 35, "male").percentile).toBeCloseTo(75, 10);
    expect(fitnessLevel(49.2, 35, "male").category).toBe("excellent");
    expect(fitnessLevel(16.0, 45, "female")).toEqual({ percentile: 5, category: "poor" });
  });
});

describe("referenceVo2max", () => {
  it("is the median (version 19; was the 75th percentile) at decade midpoints, linear between them, flat below 25", () => {
    expect(referenceVo2max(35, "male")).toBeCloseTo(42.4, 10);
    expect(referenceVo2max(40, "male")).toBeCloseTo((42.4 + 37.8) / 2, 10);
    expect(referenceVo2max(20, "male")).toBeCloseTo(48.0, 10);
  });

  it("keeps falling after 75 with the 65 → 75 slope, floored at 15 (FRIEND has no 80+ row)", () => {
    expect(referenceVo2max(75, "female")).toBeCloseTo(18.3, 10);
    expect(referenceVo2max(85, "female")).toBeCloseTo(18.3 + ((18.3 - 20.0) / 10) * 10, 10);
    expect(referenceVo2max(110, "female")).toBe(15);
  });
});

describe("the percentile by exact age, not decade (SCORING_VERSION 49)", () => {
  const SEXES: Sex[] = ["male", "female"];

  it("no birthday moves it more than a fraction of a point (version 48: up to +30.3 on a decade birthday)", () => {
    let worst = 0;
    for (const sex of SEXES)
      for (let age = 14; age <= 100; age += 0.25)
        for (let v = 10; v <= 75; v += 0.5) worst = Math.max(worst, Math.abs(vo2maxPercentile(v, age, sex) - vo2maxPercentile(v, age - 0.01, sex)));
    expect(worst).toBeLessThan(0.15);
    // The audit's case: a woman turning 30 at 36.1 read p45 → p75; now the day changes nothing.
    expect(vo2maxPercentile(36.1, 30, "female") - vo2maxPercentile(36.1, 29.99, "female")).toBeLessThan(0.05);
  });

  it("Healthspan's median reference reads the 50th percentile at every age (version 48: 37–66, and 8 at 95)", () => {
    for (const sex of SEXES) for (let age = 13; age <= 100; age += 0.5) expect(vo2maxPercentile(referenceVo2max(age, sex), age, sex)).toBeCloseTo(50, 9);
    // T13: a man of 85 at the reference (20.6) read p26 "Fair" against the 70s' row.
    expect(fitnessLevel(referenceVo2max(85, "male"), 85, "male")).toMatchObject({ category: "good" });
  });

  it("past 75 the row keeps its order and is continuous at 75 (each column floored on its own collapsed it)", () => {
    for (const sex of SEXES) {
      for (let age = 13; age <= 100; age += 0.5) {
        const row = friendRowAt(age, sex);
        for (let i = 1; i < row.length; i++) expect(row[i], `${sex} ${age}`).toBeGreaterThan(row[i - 1]);
      }
      friendRowAt(75.001, sex).forEach((v, i) => expect(v).toBeCloseTo(friendRowAt(75, sex)[i], 2));
    }
    // A woman of 85 at 16 is low for her age, not the 95th percentile.
    expect(vo2maxPercentile(16, 85, "female")).toBeLessThan(50);
  });

  it("the row at a decade midpoint is the published one", () => {
    for (const sex of SEXES) FRIEND_TREADMILL[sex].forEach((row, k) => expect(friendRowAt(25 + 10 * k, sex)).toEqual(row.map((v) => expect.closeTo(v, 10))));
    expect(FRIEND_PERCENTILES).toHaveLength(7);
  });
});
