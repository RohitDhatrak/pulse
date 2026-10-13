// Own rules (SCORING_VERSION 51): the kind of a workout, and one workout per real session. Google returns the same
// session once per source: the band's own recording (platform FITBIT) and a copy an app wrote to Health Connect (Hevy,
// Strava…). Both were stored and read, so the session showed twice and its strength minutes counted twice.
import { STRENGTH_TYPES } from "./healthspan";

export type ActivityKind = "run" | "ride" | "walk" | "strength" | "workout";

export function activityKind(type: string): ActivityKind {
  if (/RUN/.test(type)) return "run";
  if (/BIK|CYCL|RIDE/.test(type)) return "ride";
  if (/WALK|HIK/.test(type)) return "walk";
  if (STRENGTH_TYPES.test(type)) return "strength";
  return "workout";
}

/** Two workouts from different sources are one session when they overlap by at least this share of the shorter. */
export const workoutDuplicateOverlap = 0.8;

/** The band's own recording: it carries the heart-rate calories, and its id is what activities are scored under. */
const BAND_SOURCE = "FITBIT";

export type WorkoutLike = {
  id: string;
  startTs: number;
  endTs: number;
  type: string;
  source: string;
  name: string | null;
  calories: number | null;
  distanceM?: number | null;
};

const sameSession = (a: WorkoutLike, b: WorkoutLike) => {
  if (a.source === b.source) return false;
  const ka = activityKind(a.type);
  const kb = activityKind(b.type);
  if (ka !== kb && ka !== "workout" && kb !== "workout") return false;
  const overlap = Math.min(a.endTs, b.endTs) - Math.max(a.startTs, b.startTs);
  const shorter = Math.min(a.endTs - a.startTs, b.endTs - b.startTs);
  return shorter > 0 ? overlap >= workoutDuplicateOverlap * shorter : overlap >= 0 && a.startTs === b.startTs;
};

/** Better first: the band's copy, then one with calories, then the longer, then the id. */
const better = (a: WorkoutLike, b: WorkoutLike) =>
  Number(b.source === BAND_SOURCE) - Number(a.source === BAND_SOURCE) ||
  Number(b.calories != null) - Number(a.calories != null) ||
  b.endTs - b.startTs - (a.endTs - a.startTs) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * One row per session, in the input's order. Copies of a session from different sources (overlapping by at least
 * `workoutDuplicateOverlap` of the shorter, the same kind, or one of them a generic workout) are merged into the best
 * copy, which keeps its own id, times and type and takes the others' calories, distance and name where it has none.
 * Two rows from the same source are never merged with each other directly.
 */
export function mergeDuplicateWorkouts<T extends WorkoutLike>(rows: T[]): T[] {
  if (rows.length < 2) return rows;
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const order = rows.map((_, i) => i).sort((a, b) => rows[a].startTs - rows[b].startTs);
  for (let x = 0; x < order.length; x++) {
    const a = rows[order[x]];
    for (let y = x + 1; y < order.length && rows[order[y]].startTs < a.endTs; y++) {
      if (sameSession(a, rows[order[y]])) parent[find(order[y])] = find(order[x]);
    }
  }
  const groups = new Map<number, number[]>();
  rows.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const keep = new Map<number, T>();
  for (const members of groups.values()) {
    const ranked = members.map((i) => rows[i]).sort(better);
    const best = ranked[0];
    const pick = <K extends "calories" | "distanceM" | "name">(k: K) => best[k] ?? ranked.find((r) => r[k] != null)?.[k] ?? best[k];
    const merged: T = { ...best, calories: pick("calories"), name: pick("name"), ...("distanceM" in best && { distanceM: pick("distanceM") }) };
    keep.set(rows.indexOf(best), merged);
  }
  return rows.flatMap((_, i) => (keep.has(i) ? [keep.get(i)!] : []));
}
