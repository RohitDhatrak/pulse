// Test-only: a minute-level day generator for Stress and the Energy Bank (docs/algorithms/stress.md § Why version 21).
// Real people's days have meals, coffee, standing, talking, heat, illness, exercise with and without a logged workout,
// and the heart-rate tail after moving; the demo database has almost none of it. Effect sizes are assumptions.
// Heart rate per minute = the person's still level + additive effects (each with onset/offset kinetics) + noise.
// Ground truth: which minutes are psychological stress, and which effects are present.
import { energyBank, minuteLoad } from "../energyBank";
import { stress, type StressResult } from "../stress";
import { recovery } from "../../scoring/recovery";
import { foldableStillMedian, foldDaytimeBaseline } from "../../scoring/stressBase";
import type { BaselineState } from "../../scoring/types";

export type Rng = { rnd: () => number; g: () => number };
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
  return { rnd, g };
}

export interface Person {
  name: string;
  age: number;
  sleepRhr: number; // bpm during sleep
  stillOffset: number; // awake seated still HR above sleep RHR
  noise: number; // minute-mean noise SD, bpm
  maxHr: number;
  reactivity: number; // bpm added by a psychological stress episode
  wakeMin: number; // minute of day
  bedMin: number;
  job: "desk" | "standing" | "active";
  stepsPerDay: number;
  coffee: number; // cups/day
}

export type Effect = { from: number; to: number; bpm: number; tauOn?: number; tauOff?: number; kind: string };
export interface DayPlan {
  person: Person;
  wake: number;
  bed: number; // minute of day; may exceed 1440 (after midnight) — capped at 1439 here
  effects: Effect[];
  /**
   * `tauOff`: the HR's off-kinetics (default 2.5 min). `standing`: steps come in runs of 3–8 minutes between 2–10 minutes
   * of standing still (housework, cooking, errands), the heart rate up throughout; default: steps every minute.
   */
  walks: { from: number; to: number; spm: number; bpm: number; tauOff?: number; standing?: boolean }[];
  /** Minutes the band recorded no HR (taken off, loose). */
  gaps?: { from: number; to: number }[];
  workouts: { from: number; to: number; bpm: number; logged: boolean; steps: boolean; label: string }[];
  naps: { from: number; to: number }[];
  sleepRhrShift: number; // e.g. illness/alcohol raise the next sleep and whole day
  dayShift: number; // whole-day additive (illness, hangover, heat)
  artifacts: number; // per-hour rate of single-minute spikes (loose band)
  label: string;
}

export interface DayData {
  hrMin: (number | null)[];
  steps: number[];
  excluded: { start: number; end: number }[]; // minute indices
  truthStress: Uint8Array; // 1 = psychological stress minute
  truthPhysio: Uint8Array; // 1 = non-psychological HR raise ≥ 5 bpm (meal, standing, heat, illness, tail…)
  /** Each walk of 30 minutes or more (a bout of activity), minute indices [from, to). */
  bouts: { from: number; to: number }[];
  wake: number;
  bed: number;
  naps: { from: number; to: number }[];
  workouts: { from: number; to: number; logged: boolean; label: string }[];
}

/** Effect value at minute m with first-order onset and offset. */
function effectAt(e: Effect, m: number): number {
  const on = e.tauOn ?? 2;
  const off = e.tauOff ?? 3;
  if (m < e.from) return 0;
  if (m < e.to) return e.bpm * (1 - Math.exp(-(m - e.from + 1) / on));
  const peak = e.bpm * (1 - Math.exp(-(e.to - e.from) / on));
  return peak * Math.exp(-(m - e.to + 1) / off);
}

export function renderDay(p: DayPlan, r: Rng): DayData {
  const n = 1440;
  const hr = new Float64Array(n);
  const steps = new Array<number>(n).fill(0);
  const truthStress = new Uint8Array(n);
  const truthPhysio = new Uint8Array(n);
  const P = p.person;
  const bed = Math.min(1439, p.bed);
  const asleep = (m: number) => m < p.wake || m >= bed || p.naps.some((x) => m >= x.from && m < x.to);
  // Walks and workouts as effects with exercise kinetics (fast on, slower off: a recovery tail).
  const effects: Effect[] = [
    ...p.effects,
    ...p.walks.map((w) => ({ from: w.from, to: w.to, bpm: w.bpm, tauOn: 1.5, tauOff: w.tauOff ?? 2.5, kind: "walk" })),
    ...p.workouts.map((w) => ({ from: w.from, to: w.to, bpm: w.bpm, tauOn: 2, tauOff: 12, kind: "workout" })),
  ];
  for (const w of p.walks) {
    for (let m = w.from, on = true; m < w.to; on = !on) {
      const len = !w.standing ? w.to - w.from : on ? 3 + Math.round(5 * r.rnd()) : 2 + Math.round(8 * r.rnd());
      for (const end = Math.min(w.to, m + len); m < end; m++) if (on) steps[m] = Math.round(w.spm * (0.85 + 0.3 * r.rnd()));
    }
  }
  for (const w of p.workouts) if (w.steps) for (let m = w.from; m < w.to; m++) steps[m] = 150 + Math.round(20 * r.g());
  for (let m = 0; m < n; m++) {
    if (asleep(m)) {
      hr[m] = P.sleepRhr + p.sleepRhrShift + 2 * r.g();
      continue;
    }
    let v = P.sleepRhr + p.sleepRhrShift + P.stillOffset + p.dayShift;
    let psych = 0;
    let physio = p.dayShift;
    for (const e of effects) {
      const x = effectAt(e, m);
      v += x;
      if (e.kind === "stress") psych += x;
      else if (e.kind !== "walk" && e.kind !== "workout") physio += x;
      else if (m >= e.to) physio += x; // a recovery tail after moving counts as non-psychological
    }
    v += P.noise * r.g();
    hr[m] = v;
    if (psych >= 4) truthStress[m] = 1;
    if (physio >= 5) truthPhysio[m] = 1;
    if (p.artifacts && r.rnd() < p.artifacts / 60) hr[m] += 25 + 15 * r.rnd();
  }
  const excluded = [
    { start: 0, end: p.wake },
    ...(bed < 1440 ? [{ start: bed, end: 1440 }] : []),
    ...p.naps.map((x) => ({ start: x.from, end: x.to })),
    ...p.workouts.filter((w) => w.logged).map((w) => ({ start: w.from, end: w.to })),
  ];
  return {
    hrMin: Array.from(hr, (v, m) => (p.gaps?.some((g) => m >= g.from && m < g.to) ? null : Math.max(35, Math.min(210, v)))),
    steps,
    excluded,
    truthStress,
    truthPhysio,
    bouts: p.walks.filter((w) => w.to - w.from >= 30).map((w) => ({ from: w.from, to: w.to })),
    wake: p.wake,
    bed,
    naps: p.naps,
    workouts: p.workouts.map((w) => ({ from: w.from, to: w.to, logged: w.logged, label: w.label })),
  };
}

// ── Day plans ────────────────────────────────────────────────────────────────────────────────────────────────────
export type Scenario =
  | "calm_desk"
  | "stressful_work"
  | "short_spikes"
  | "coffee_heavy"
  | "hot_day"
  | "illness"
  | "hangover"
  | "unlogged_cycling"
  | "unlogged_weights"
  | "logged_run"
  | "double_training"
  | "standing_job"
  | "active_job"
  | "rest_day"
  | "long_day"
  | "nap_day"
  | "loose_band"
  | "chaotic_parent"
  | "long_stress"
  | "light_activity"
  | "stress_after_walk";

/** Everyday background for an awake day: meals, coffee, desk breaks, talking, standing. */
function everyday(P: Person, wake: number, bed: number, r: Rng, plan: DayPlan) {
  const meals = [wake + 30, 12.5 * 60 + 30 * r.g(), 19.5 * 60 + 40 * r.g()];
  for (const t of meals) {
    const at = Math.round(t);
    plan.walks.push({ from: at - 6, to: at - 2, spm: 60, bpm: 15 }); // walk to the table/kitchen
    plan.effects.push({ from: at, to: at + 25, bpm: 4 + 4 * r.rnd(), tauOn: 15, tauOff: 40, kind: "meal" });
  }
  for (let c = 0; c < P.coffee; c++) {
    const at = Math.round(wake + 20 + c * 180 + 30 * r.g());
    plan.effects.push({ from: at, to: at + 120, bpm: 3 + 2 * r.rnd(), tauOn: 20, tauOff: 90, kind: "coffee" });
  }
  // Getting up: short walks every 30–90 min.
  for (let t = wake + 45; t < bed - 30; t += 30 + Math.round(60 * r.rnd())) {
    const len = 1 + Math.round(4 * r.rnd());
    plan.walks.push({ from: t, to: t + len, spm: 70 + 30 * r.rnd(), bpm: 18 + 10 * r.rnd() });
  }
  // A commute or errand walk.
  const cw = Math.round(8.5 * 60 + 20 * r.g());
  plan.walks.push({ from: cw, to: cw + 15 + Math.round(10 * r.rnd()), spm: 105, bpm: 28 });
  const ew = Math.round(17.75 * 60 + 20 * r.g());
  plan.walks.push({ from: ew, to: ew + 15 + Math.round(10 * r.rnd()), spm: 105, bpm: 28 });
  // Talking (calls, conversation): +4–8, 1–2 h total in chunks; still.
  for (let k = 0; k < 3; k++) {
    const at = Math.round(10 * 60 + k * 150 + 60 * r.rnd());
    plan.effects.push({ from: at, to: at + 20 + Math.round(25 * r.rnd()), bpm: 4 + 4 * r.rnd(), kind: "talk" });
  }
  // Standing still (cooking, queue, standing desk): +8–12 with no steps.
  const st = P.job === "standing" ? 8 : 2;
  for (let k = 0; k < st; k++) {
    const at = Math.round(wake + 60 + r.rnd() * (bed - wake - 120));
    plan.effects.push({ from: at, to: at + 10 + Math.round(20 * r.rnd()), bpm: 8 + 4 * r.rnd(), kind: "stand" });
  }
  if (P.job === "active") {
    // On the move most of the working day.
    for (let t = 9 * 60; t < 17 * 60; t += 20) plan.walks.push({ from: t, to: t + 12, spm: 60 + 40 * r.rnd(), bpm: 15 + 10 * r.rnd() });
  }
}

export function planDay(P: Person, s: Scenario, r: Rng): DayPlan {
  const wake = Math.round(P.wakeMin + 25 * r.g());
  let bed = Math.round(P.bedMin + 25 * r.g());
  const plan: DayPlan = { person: P, wake, bed, effects: [], walks: [], workouts: [], naps: [], sleepRhrShift: 0, dayShift: 0, artifacts: 0, label: s };
  if (s === "long_day") {
    plan.wake = P.wakeMin - 90;
    bed = plan.bed = Math.min(1439, P.bedMin + 90);
  }
  if (s !== "rest_day") everyday(P, plan.wake, bed, r, plan);
  else {
    // Weekend: meals, a long easy walk, lots of sitting.
    const t = 11 * 60;
    plan.walks.push({ from: t, to: t + 60, spm: 95, bpm: 22 });
    for (const m of [plan.wake + 60, 13.5 * 60, 19.5 * 60]) plan.effects.push({ from: Math.round(m), to: Math.round(m) + 25, bpm: 6, tauOn: 15, tauOff: 40, kind: "meal" });
  }
  const stress = (at: number, len: number, mult = 1) =>
    plan.effects.push({ from: at, to: at + len, bpm: P.reactivity * mult * (0.8 + 0.4 * r.rnd()), tauOn: 4, tauOff: 8, kind: "stress" });
  switch (s) {
    case "stressful_work":
      stress(Math.round(10 * 60 + 30 * r.rnd()), 45 + Math.round(30 * r.rnd()));
      stress(Math.round(14 * 60 + 30 * r.rnd()), 30 + Math.round(30 * r.rnd()));
      stress(Math.round(16.5 * 60 + 20 * r.rnd()), 20 + Math.round(20 * r.rnd()), 0.8);
      break;
    case "long_stress":
      stress(Math.round(13 * 60 + 20 * r.rnd()), 150);
      break;
    case "short_spikes":
      for (let k = 0; k < 6; k++) stress(Math.round(9.5 * 60 + k * 70 + 20 * r.rnd()), 3 + Math.round(4 * r.rnd()));
      break;
    case "coffee_heavy":
      for (let c = 0; c < 4; c++) plan.effects.push({ from: plan.wake + 30 + c * 120, to: plan.wake + 150 + c * 120, bpm: 5 + 2 * r.rnd(), tauOn: 20, tauOff: 90, kind: "coffee" });
      break;
    case "hot_day":
      plan.effects.push({ from: 12 * 60, to: 18 * 60, bpm: 7 + 3 * r.rnd(), tauOn: 60, tauOff: 90, kind: "heat" });
      break;
    case "illness":
      plan.dayShift = 9 + 3 * r.rnd();
      plan.sleepRhrShift = 6;
      break;
    case "hangover":
      plan.dayShift = 5 + 2 * r.rnd();
      plan.sleepRhrShift = 5;
      break;
    case "unlogged_cycling": {
      const t = Math.round(18 * 60 + 20 * r.g());
      plan.workouts.push({ from: t, to: t + 60, bpm: 65, logged: false, steps: false, label: "Ride" });
      break;
    }
    case "unlogged_weights": {
      const t = Math.round(18 * 60 + 20 * r.g());
      plan.workouts.push({ from: t, to: t + 50, bpm: 35, logged: false, steps: false, label: "Weights" });
      break;
    }
    case "logged_run": {
      const t = Math.round(7.25 * 60 + 15 * r.g());
      plan.workouts.push({ from: Math.max(plan.wake + 15, t), to: Math.max(plan.wake + 15, t) + 45, bpm: 75, logged: true, steps: true, label: "Run" });
      break;
    }
    case "double_training": {
      plan.workouts.push({ from: plan.wake + 20, to: plan.wake + 80, bpm: 75, logged: true, steps: true, label: "Run" });
      const t = Math.round(18 * 60);
      plan.workouts.push({ from: t, to: t + 75, bpm: 60, logged: true, steps: false, label: "Ride" });
      break;
    }
    case "nap_day":
      plan.naps.push({ from: 14 * 60, to: 14 * 60 + 25 });
      break;
    case "loose_band":
      plan.artifacts = 3;
      break;
    case "light_activity": {
      // Version 36, the owner's late mornings: 60–80 min of housework or errands, steps in runs between standing, the
      // heart rate 55–80 % of the way from the still level to the exertion line (40 % of reserve), easing off over half an hour or more (τ 14 min), with a
      // 15-minute band gap in some bouts.
      const t = Math.round(10.5 * 60 + 15 * r.g());
      const len = 60 + Math.round(20 * r.rnd());
      const still = P.sleepRhr + P.stillOffset;
      const line = P.sleepRhr + 0.4 * (P.maxHr - P.sleepRhr);
      plan.walks.push({ from: t, to: t + len, spm: 15 + 35 * r.rnd(), bpm: (line - still) * (0.55 + 0.25 * r.rnd()), tauOff: 14, standing: true });
      if (r.rnd() < 0.5) plan.gaps = [{ from: t + 20, to: t + 35 }];
      break;
    }
    case "stress_after_walk": {
      // A 20-minute brisk walk to a meeting, then 40 minutes of a stress response, still.
      const t = Math.round(10.5 * 60 + 15 * r.g());
      plan.walks.push({ from: t, to: t + 20, spm: 105, bpm: 28 });
      stress(t + 20, 40);
      break;
    }
    case "chaotic_parent":
      for (let k = 0; k < 4; k++) stress(Math.round(7.5 * 60 + k * 200 + 40 * r.rnd()), 15 + Math.round(20 * r.rnd()), 0.7);
      for (let t = plan.wake + 20; t < bed - 20; t += 25 + Math.round(30 * r.rnd())) plan.walks.push({ from: t, to: t + 3 + Math.round(5 * r.rnd()), spm: 60, bpm: 18 });
      break;
  }
  plan.bed = bed;
  return plan;
}

// ── People ───────────────────────────────────────────────────────────────────────────────────────────────────────
export function people(): Person[] {
  const P = (o: Partial<Person> & { name: string }): Person => ({
    age: 35, sleepRhr: 56, stillOffset: 14, noise: 3, maxHr: 185, reactivity: 14, wakeMin: 7 * 60, bedMin: 23 * 60,
    job: "desk", stepsPerDay: 7000, coffee: 2, ...o,
  });
  return [
    P({ name: "typical desk worker" }),
    P({ name: "fit athlete", age: 28, sleepRhr: 44, stillOffset: 16, maxHr: 195, noise: 3.5 }),
    P({ name: "older adult", age: 68, sleepRhr: 60, stillOffset: 10, maxHr: 152, noise: 2.5, reactivity: 10 }),
    P({ name: "high-reactor", reactivity: 22 }),
    P({ name: "low-reactor", reactivity: 8 }),
    P({ name: "noisy HR (Fitbit wrist)", noise: 5 }),
    P({ name: "clean HR", noise: 1.8 }),
    P({ name: "standing job", job: "standing" }),
    P({ name: "active job", job: "active" }),
    P({ name: "early bird", wakeMin: 5 * 60 + 30, bedMin: 21 * 60 + 30 }),
    P({ name: "night owl", wakeMin: 9 * 60, bedMin: 1439 }),
    P({ name: "heavy coffee", coffee: 5 }),
  ];
}

/** A realistic mixed week, Monday first: mostly ordinary days with occasional stress, training, a weekend. */
export function weekMix(r: Rng): Scenario[] {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r.rnd() * xs.length)];
  return [
    pick(["calm_desk", "calm_desk", "stressful_work", "logged_run"]),
    pick(["calm_desk", "stressful_work", "coffee_heavy"]),
    pick(["calm_desk", "logged_run", "unlogged_weights", "calm_desk"]),
    pick(["calm_desk", "stressful_work", "short_spikes"]),
    pick(["calm_desk", "calm_desk", "hot_day", "stressful_work"]),
    pick(["rest_day", "logged_run", "nap_day"]),
    pick(["rest_day", "rest_day", "unlogged_cycling"]),
  ];
}

// ── Scoring a generated day as the pipeline does ────────────────────────────────────────────────────────────────

const DAY = 86400;
const MASK: BaselineState = { baseline: 0, spread: 1, nValid: 1, nightsSinceUpdate: 0, status: "calibrating" };

export type ScoredDay = { scenario: Scenario; day: DayData; stress: StressResult; eb: ReturnType<typeof energyBank> };

/** Recovery-side inputs for the Energy Bank's start, by scenario: HRV and resting-HR z, sleep performance. */
function nightFor(s: Scenario, r: Rng) {
  let hz = r.g() * 0.8, rz = r.g() * 0.8, sp = 88 + 4 * r.g();
  if (s === "illness") { hz -= 2; rz -= 2; sp -= 8; }
  if (s === "hangover") { hz -= 1.3; rz -= 1.2; sp -= 10; }
  if (s === "long_day") sp -= 6;
  return { hz, rz, sp: Math.max(40, Math.min(100, sp)) };
}

/** Stage 1 masks (steps, sleep, workouts, exertion), stage 2 scores the still series against the folded baseline. */
export function scoreDay(P: Person, s: Scenario, dayIndex: number, history: (number | null)[], r: Rng): ScoredDay {
  const plan = planDay(P, s, r);
  const d = renderDay(plan, r);
  const start = dayIndex * DAY;
  const restingHr = P.sleepRhr + plan.sleepRhrShift;
  const hr = d.hrMin.flatMap((bpm, m) => (bpm == null ? [] : [{ ts: start + m * 60 + 30, bpm }]));
  const probe = stress({
    start, end: start + DAY, hr, steps: d.steps,
    excluded: d.excluded.map((x) => ({ start: start + x.start * 60, end: start + x.end * 60 })),
    baseline: MASK,
    exertion: { restingHr, maxHr: P.maxHr, workouts: d.workouts.filter((w) => w.logged).map((w) => ({ start: start + w.from * 60, end: start + w.to * 60 })) },
  });
  const still = probe.minutes.flatMap((v, m) => (v == null || d.hrMin[m] == null ? [] : [{ ts: start + m * 60 + 30, bpm: d.hrMin[m]! }]));
  const st = stress({ start, end: start + DAY, hr: still, steps: [], excluded: [], baseline: foldDaytimeBaseline(history) });
  const n = nightFor(s, r);
  const B = { hrvBaseline: { mean: 0, spread: 1 }, rhrBaseline: { mean: 0, spread: 1 }, respBaseline: { mean: 0, spread: 1 } };
  const eb = energyBank({
    start, wake: start + d.wake * 60, until: start + d.bed * 60,
    recoveryWithoutSleep: recovery({ hrv: n.hz, rhr: -n.rz, resp: 0, ...B, sleepPerf: null, skinTempDev: 0 })!,
    sleepPerformance: n.sp,
    load: minuteLoad(d.hrMin, restingHr, P.maxHr),
    stress: st.minutes,
    naps: d.naps.map((x) => ({ start: start + x.from * 60, end: start + x.to * 60 })),
    workouts: d.workouts.map((w) => ({ start: start + w.from * 60, end: start + w.to * 60, label: w.label })),
  });
  return { scenario: s, day: d, stress: st, eb };
}

/** Weeks of a realistic mix, folding each day's still median through the pipeline's gate. */
export function warmUp(P: Person, seed: number, weeks = 7) {
  const r = rng(seed);
  const history: (number | null)[] = [];
  let i = 0;
  for (let w = 0; w < weeks; w++) for (const s of weekMix(r)) {
    const x = scoreDay(P, s, i++, history, r);
    history.push(foldableStillMedian(history, x.stress.stillMedianHr));
  }
  return { history, nextDay: i };
}

/** High-stress minutes on a scored day. */
export const highMinutes = (x: ScoredDay) => x.stress.minutes.filter((v) => v != null && v >= 2).length;
/** High minutes during each bout of activity and the `after` minutes after it. */
export const highAroundBouts = (x: ScoredDay, after = 45) =>
  x.day.bouts.reduce((a, b) => a + x.stress.minutes.slice(b.from, b.to + after).filter((v) => v != null && v >= 2).length, 0);
/** Share of the labelled stress minutes that read high, counting the ones not scored at all (blocked) as missed. */
export function caughtOfAll(xs: ScoredDay[]): number {
  let t = 0, h = 0;
  for (const x of xs) for (let m = 0; m < 1440; m++) if (x.day.truthStress[m]) { t++; if (x.stress.minutes[m] != null && x.stress.minutes[m]! >= 2) h++; }
  return t ? h / t : NaN;
}
/** Share of the labelled stress minutes that were scored and read high. */
export function caught(xs: ScoredDay[]): number {
  let t = 0, h = 0;
  for (const x of xs) for (let m = 0; m < 1440; m++) if (x.day.truthStress[m] && x.stress.minutes[m] != null) { t++; if (x.stress.minutes[m]! >= 2) h++; }
  return t ? h / t : NaN;
}
