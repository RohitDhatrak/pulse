// Plain data helpers for the Recharts components. No SVG maths: these only shape series and slices
// that Recharts primitives draw (spec §5.0, §5.1, §5.6).

/** A colour band: values at or above `from` take `color` (bands ascending). */
export type Band = { from: number; color: string };

/** The band colour of a value. */
export const bandColor = (v: number, bands: Band[]) => [...bands].reverse().find((b) => v >= b.from)?.color ?? bands[0].color;

/**
 * Gradient stops, top (offset 0) to bottom (offset 1), for a shape spanning values `top` to `bottom`: the top's colour,
 * a hard switch at every threshold strictly inside the span, and the bottom's colour.
 */
export function bandStops(top: number, bottom: number, bands: Band[]): { offset: number; color: string }[] {
  const at = (v: number) => (top - v) / (top - bottom);
  const stops = [{ offset: 0, color: bandColor(top, bands) }];
  for (const b of [...bands].reverse()) {
    if (b.from >= top || b.from <= bottom) continue;
    stops.push({ offset: at(b.from), color: bandColor(b.from, bands) }, { offset: at(b.from), color: bandColor(b.from - 1e-9, bands) });
  }
  stops.push({ offset: 1, color: bandColor(bottom, bands) });
  return stops;
}

// --- Hypnogram ---

export type Stage = "awake" | "rem" | "light" | "deep";
export const STAGES: Stage[] = ["awake", "rem", "light", "deep"];
export const STAGE_LANE: Record<Stage, number> = { awake: 3, rem: 2, light: 1, deep: 0 };
export type StageSegment = { stage: Stage; start: number; end: number };
type LanePoint = { t: number; lane: number | null };

/**
 * The connector runs through every segment start (stepAfter) and ends at the last wake. Each stage
 * gets its own series holding its lane only inside its segments, with a null after each one so
 * two separate REM blocks never join across the night.
 */
export function hypnogramSeries(segments: StageSegment[]) {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const connector: LanePoint[] = sorted.map((s) => ({ t: s.start, lane: STAGE_LANE[s.stage] }));
  const last = sorted.at(-1);
  if (last) connector.push({ t: last.end, lane: STAGE_LANE[last.stage] });
  const stages = Object.fromEntries(STAGES.map((s) => [s, [] as LanePoint[]])) as Record<Stage, LanePoint[]>;
  for (const s of sorted) {
    const lane = STAGE_LANE[s.stage];
    stages[s.stage].push({ t: s.start, lane }, { t: s.end, lane }, { t: s.end, lane: null });
  }
  return { connector, stages };
}

// --- Time axes ---

const MINUTE = 60_000;
function localMinuteOfDay(ms: number, timeZone?: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "numeric", hourCycle: "h23", timeZone }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/** Ticks on whole local clock times that are multiples of `stepMinutes` (60 = whole hours), inside [start, end]. */
export function clockTicks(start: number, end: number, stepMinutes = 60, timeZone?: string) {
  const firstMinute = Math.ceil(start / MINUTE) * MINUTE;
  const into = localMinuteOfDay(firstMinute, timeZone) % stepMinutes;
  const ticks: number[] = [];
  for (let t = firstMinute + (into ? stepMinutes - into : 0) * MINUTE; t <= end; t += stepMinutes * MINUTE) ticks.push(t);
  return ticks;
}

/** Whole local hours that are multiples of `stepHours`. */
export const hourTicks = (start: number, end: number, stepHours = 1, timeZone?: string) => clockTicks(start, end, stepHours * 60, timeZone);

/** Y domain rounded out to 10s with 10 of headroom: [min - 10, max + 10]. */
export function paddedDomain(values: (number | null)[]): [number, number] {
  const v = values.filter((x): x is number => x !== null);
  if (!v.length) return [40, 180];
  return [Math.floor((Math.min(...v) - 10) / 10) * 10, Math.ceil((Math.max(...v) + 10) / 10) * 10];
}

// --- ScoreDial slices (Pie data, not angles) ---

/** Strain Target band on the 0-21 track: [before, band, after]. */
export function targetSlices(lo: number, hi: number, max = 21) {
  const a = Math.min(Math.max(lo, 0), max);
  const b = Math.min(Math.max(hi, a), max);
  return [a, b - a, max - b];
}

/** A thin marker slice centred on `value`: [before, width, after], clamped to the domain. */
export function markerSlices(value: number, max: number, width: number) {
  const mid = Math.min(Math.max(value, width / 2), max - width / 2);
  return [mid - width / 2, width, max - mid - width / 2];
}

/**
 * Ring radii as percentages of the dial radius, so the 768 px size step needs no JS. `inset` px
 * are reserved outside the ring for the strain tick, which overhangs the ring by 2 px. `hole` is
 * the inset of the ring's inner edge from the box edge, as a percentage of the diameter: the
 * dial's centre content lays out in that square and sizes itself from it (spec §11 F23).
 */
export function ringRadii(diameter: number, ring: number, inset = 2) {
  const r = diameter / 2;
  const pct = (px: number) => `${Math.round((px / r) * 1000) / 10}%`;
  return {
    outer: pct(r - inset),
    inner: pct(r - inset - ring),
    tickOuter: "100%",
    tickInner: pct(r - inset - ring - 2),
    hole: `${Math.round(((inset + ring) / diameter) * 1000) / 10}%`,
  };
}
