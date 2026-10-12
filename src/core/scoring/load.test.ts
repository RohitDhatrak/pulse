import { describe, expect, it } from "vitest";
import { hardOrLateConfig, hardOrLateWorkout, loadToStrain, seenLoad, seenLoadConfig, typicalSession } from "./load";

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

describe("seenLoad: a day counts only when it was seen (SCORING_VERSION 46)", () => {
  it("uses 20 TRIMP and 120 awake minutes", () => {
    expect(seenLoadConfig).toEqual({ minSeenLoad: 20, minAwakeWornMin: 120 });
  });

  it("a band-off day is unknown", () => {
    expect(seenLoad(null, false, 0)).toBeNull();
  });

  it("a day worn only in bed is unknown, not a rest day's 0 (version 45: 0)", () => {
    expect(seenLoad(0, true, 15)).toBeNull();
    expect(seenLoad(null, true, 0)).toBeNull();
    expect(seenLoad(3, true, 119)).toBeNull();
  });

  it("a day worn long enough while awake is a measured rest day, 0 included", () => {
    expect(seenLoad(null, true, 120)).toBe(0);
    expect(seenLoad(4, true, 900)).toBe(4);
  });

  it("a workout counts on any wear: the band on only for the run", () => {
    expect(seenLoad(20, true, 0)).toBe(20);
    expect(seenLoad(85, true, 70)).toBe(85);
    expect(seenLoad(19.9, true, 70)).toBeNull();
  });
});
