import { describe, expect, it } from "vitest";
import { activityKind, mergeDuplicateWorkouts, type WorkoutLike, workoutDuplicateOverlap } from "./workouts";

const at = (iso: string) => Date.parse(iso) / 1000;
const w = (id: string, source: string, start: string, end: string, over: Partial<WorkoutLike> = {}): WorkoutLike => ({
  id,
  source,
  startTs: at(start),
  endTs: at(end),
  type: "STRENGTH_TRAINING",
  name: "Strength training",
  calories: null,
  distanceM: null,
  ...over,
});

describe("one workout per session (SCORING_VERSION 51)", () => {
  // The owner's session on 2026-10-13: the band's recording and Hevy's copy written to Health Connect.
  const band = w("8714362417455905768", "FITBIT", "2026-10-13T03:44:25Z", "2026-10-13T05:07:06Z", { calories: 575 });
  const hevy = w("6608531042253026048", "HEALTH_CONNECT", "2026-10-13T03:43:43Z", "2026-10-13T05:07:40Z");

  it("the band's copy and Hevy's Health Connect copy are one session: the band's survives, with its 575 kcal", () => {
    for (const rows of [[band, hevy], [hevy, band]]) expect(mergeDuplicateWorkouts(rows)).toEqual([band]);
  });

  it("the survivor takes the other copy's calories, distance and name where it has none", () => {
    const run = (id: string, source: string, over: Partial<WorkoutLike>) => w(id, source, "2026-10-13T01:00:00Z", "2026-10-13T01:40:00Z", { type: "RUNNING", ...over });
    const merged = mergeDuplicateWorkouts([run("a", "FITBIT", { name: null }), run("b", "HEALTH_CONNECT", { calories: 410, distanceM: 8000, name: "Morning run" })]);
    expect(merged).toEqual([{ ...run("a", "FITBIT", {}), name: "Morning run", calories: 410, distanceM: 8000 }]);
  });

  it("two overlapping workouts from the same source are both kept", () => {
    const again = { ...band, id: "x", startTs: band.startTs + 60 };
    expect(mergeDuplicateWorkouts([band, again])).toHaveLength(2);
  });

  it(`an overlap under ${workoutDuplicateOverlap * 100} % of the shorter is two sessions (a walk inside another app's long hike)`, () => {
    const hike = w("hike", "HEALTH_CONNECT", "2026-10-13T06:00:00Z", "2026-10-13T09:00:00Z", { type: "HIKING" });
    const walk = w("walk", "FITBIT", "2026-10-13T08:40:00Z", "2026-10-13T09:30:00Z", { type: "WALKING" }); // 20 of 50 min overlap
    expect(mergeDuplicateWorkouts([hike, walk])).toHaveLength(2);
  });

  it("different kinds are two sessions; a generic workout matches any kind", () => {
    const run = { ...hevy, id: "run", type: "RUNNING" };
    expect(mergeDuplicateWorkouts([band, run])).toHaveLength(2);
    const other = { ...hevy, id: "other", type: "OTHER" };
    expect(activityKind(other.type)).toBe("workout");
    expect(mergeDuplicateWorkouts([band, other])).toEqual([band]);
  });

  it("three copies are one, whatever the order; without a band copy the one with calories wins", () => {
    const strava = { ...hevy, id: "strava", source: "google" };
    for (const rows of [[band, hevy, strava], [strava, hevy, band], [hevy, band, strava]]) expect(mergeDuplicateWorkouts(rows)).toEqual([band]);
    const withKcal = { ...strava, calories: 300 };
    expect(mergeDuplicateWorkouts([hevy, withKcal])).toEqual([withKcal]);
  });

  it("separate sessions, and the order of the rest, are untouched", () => {
    const later = w("later", "FITBIT", "2026-10-13T12:00:00Z", "2026-10-13T12:30:00Z", { type: "WALKING" });
    expect(mergeDuplicateWorkouts([hevy, band, later])).toEqual([band, later]);
  });
});
