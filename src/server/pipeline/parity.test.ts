// The Postgres pipeline scores the demo database exactly as the snapshot in __parity__ records. It first proved the
// port reproduced the SQLite build (8e93863); re-recorded 2026-10-04 when the seed moved to day-index keys (the
// demo's inputs changed, not the scorers). Re-recorded for SCORING_VERSION 9 (early-baseline spread and z shrink):
// only recovery moved; strain and sleep are byte-identical to the previous snapshot. Re-recorded for SCORING_VERSION 15
// (sleep need: median, adult floor 7 h): sleep and recovery moved by design; strain is byte-identical.
// Re-recorded for SCORING_VERSION 17 (Recovery's sleep term centred on your own usual night): only recovery moved;
// strain and sleep are byte-identical.
// Re-recorded for SCORING_VERSION 30 (the illness hold): only recovery moved, from the seed's illness on (3 held nights,
// then the week after 3–6 points lower, fading to under 1 point within a month); strain and sleep are byte-identical.
// Re-recorded for SCORING_VERSION 32 (a robust first week for baselines): only recovery moved, by at most 0.41 points in
// days 7–29 and about 0.01 after day 60 (the seed has no early glitch); strain and sleep are byte-identical.
import { expect, it } from "vitest";
import { rows, sql } from "../db";
import { seeded, USER } from "../testing";
import snapshot from "./__parity__/sqlite-scores.json";

type Day = { day: string; recovery: number | null; strain: number | null; sleep: number | null };

it("reproduces the SQLite build's recovery, strain and sleep on every seeded day", async () => {
  const actual = await rows<Day>(
    await seeded(),
    sql`select day, (recovery->>'value')::float8 recovery, (strain->>'effort')::float8 strain,
          coalesce((sleep->>'performance')::float8, (sleep->>'value')::float8) sleep
        from daily_scores where user_id = ${USER} order by day`,
  );
  const expected = snapshot as Day[];
  expect(actual.map((d) => d.day)).toEqual(expected.map((d) => d.day));
  expected.forEach((e, i) => {
    for (const k of ["recovery", "strain", "sleep"] as const) {
      const a = actual[i][k];
      if (e[k] == null) expect(a, `${e.day} ${k}`).toBeNull();
      else expect(Math.abs(a! - e[k]!), `${e.day} ${k}: ${a} vs ${e[k]}`).toBeLessThan(1e-6);
    }
  });
});
