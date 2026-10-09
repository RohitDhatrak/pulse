import { describe, expect, it } from "vitest";
import { hardOrLateConfig, hardOrLateWorkout, loadToStrain, typicalSession } from "./load";

describe("hardOrLateWorkout (SCORING_VERSION 23)", () => {
  // 28 days: training days at 100 TRIMP every other day, rest days at 5.
  const prior = Array.from({ length: 28 }, (_, i) => (i % 2 ? 100 : 5));
  const typical = typicalSession(prior)!;
  /** The TRIMP that sits `points` Day Strain points above the typical session (bisection). */
  const loadAt = (points: number) => {
    let lo = typical, hi = typical * 20;
    for (let k = 0; k < 80; k++) {
      const mid = (lo + hi) / 2;
      if (loadToStrain(mid) - loadToStrain(typical) < points) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  const base = { priorLoads: prior, workouts: [], bedtime: null };

  it("hard: 2 Day Strain points above your typical session; 1.9 is not", () => {
    expect(typical).toBe(100);
    expect(hardOrLateWorkout({ ...base, load: loadAt(2) })).toBe(true);
    expect(hardOrLateWorkout({ ...base, load: loadAt(1.9) })).toBe(false);
    expect(hardOrLateWorkout({ ...base, load: 100 })).toBe(false); // an ordinary training day
  });

  it("no history or no load: not hard", () => {
    expect(hardOrLateWorkout({ ...base, priorLoads: [], load: 500 })).toBe(false);
    expect(hardOrLateWorkout({ ...base, load: null })).toBe(false);
  });

  it("late: a 30-minute workout ending within 2 h of bedtime; 2 h 10 before, or a 25-minute one, is not", () => {
    const bed = 1_790_000_000;
    const w = (endBeforeBedMin: number, lenMin: number) => ({ start: bed - (endBeforeBedMin + lenMin) * 60, end: bed - endBeforeBedMin * 60 });
    const late = (endBefore: number, len: number) => hardOrLateWorkout({ ...base, load: 50, workouts: [w(endBefore, len)], bedtime: bed });
    expect(late(110, 30)).toBe(true);
    expect(late(130, 30)).toBe(false);
    expect(late(60, 25)).toBe(false);
    expect(hardOrLateWorkout({ ...base, load: 50, workouts: [w(60, 45)], bedtime: null })).toBe(false);
    expect(hardOrLateConfig).toEqual({ hardWorkoutStrainPoints: 2, lateWorkoutHours: 2, lateWorkoutMinMin: 30 });
  });
});
