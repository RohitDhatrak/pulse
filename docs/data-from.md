# Count my data from (scoring version 34)

A per-user date, set in Settings › **Count my data from**, from which Pulse counts data. Every score, baseline,
chart, trend, report and journal-impact result starts on that day, as if earlier days didn't exist. Earlier data
**stays stored**: clearing the date, or moving it back, brings it back on the next recompute. When the device on your
main sleeps changes and stays changed, Pulse **suggests** the date; nothing changes until you confirm.

## Why

Devices measure differently. On the owner's account, 180 days came from a phone and watch through Health Connect,
then a Fitbit from Oct 4:
- resting HR medians differ by about 5.5 bpm between the devices, and SpO2 by about 4 points;
- every Health Connect night was unstaged.

Both jumps are smaller than the hard-outlier gate, so version 33's restart (`docs/algorithms/baselines.md` § Why
version 33) doesn't fire. Instead, Recovery, the Health Monitor, sleep need and stress blend the two devices for
weeks. Before this, deleting rows was the only fix, and a full re-import from Google brought them back.

## The rule

- **Stored:** `profile.data_from` (nullable date, migration `0006`). Setting, changing or clearing it marks every
  stored day dirty (`setDataFrom`, `src/server/profile.ts`) and forces a sync, so the pipeline recomputes everything.
- **Pipeline** (`src/server/pipeline/data.ts` `load`): metrics, sessions and exercises before the date are left out,
  and the heart-rate span starts at it. Stage 2 already deletes `daily_scores`, intraday series and reports outside the
  loaded days, so old scores disappear without extra code. Journal impact and reports are built from the folded days,
  so they also start at the date. Baselines start from scratch there, with version 32's robust first week.
- **Screens** (`src/server/queries/common.ts`): `loadDays`, `loadSeries` and `exercisesBetween` clamp to the date.
  The direct reads (heart rate, hourly steps, the activity list and a single activity) clamp too.
- **Not filtered:** your journal entries. Only their impact starts at the date.
- **`SCORING_VERSION` 33 → 34.** Without a date nothing changes; only the version stamp moved on the seed (`GOLDEN[34]`).

## The suggestion

Google merges daily metrics across sources (`daily_metrics.source` is always `google`), but sleep sessions keep the
device platform: `FITBIT` for the band, `HEALTH_CONNECT` for a phone or another watch. `detectDeviceSwitch`
(`src/core/deviceSwitch.ts`) reads the source of each main sleep and returns the latest switch when:
- the new source holds for the last **3** main sleeps in a row (`minNewNights`): a single stray sync isn't a switch;
- the old source had at least **7** main sleeps before it (`minOldNights`): less history isn't worth starting over for.
  Single nights from a third source inside the old run are ignored.

The day suggested is the wake day of the new source's first main sleep. It is shown (`deviceSwitchFor`) unless the
user dismissed that day, or already counts data from it or later.

- **Settings:** a note "Looks like a new device since {day}" with **Use {day}** and **Dismiss**.
- **Home** (today's view): a banner row linking to `/settings#data-from`.

## Tests

- `src/core/deviceSwitch.test.ts`: the rule (thresholds, order, strays, a switch back, none).
- `src/server/pipeline/pipeline.test.ts` "count my data from": with the date at day 60, scores start there, Recovery
  recalibrates over days 60–66, no intraday series before it, and stored metrics are kept. Clearing the date restores
  `daily_scores` and reports byte for byte.
- `src/server/queries/dataFrom.test.ts`: the query clamps, and the suggestion end to end on a seed whose main sleeps
  are relabelled from Health Connect to Fitbit.
- `src/server/profile.test.ts`: set, change, clear and dismiss.

## On the owner's real data (a local copy)

- The suggestion is Oct 4 (Health Connect → Fitbit).
- Without a date: 186 days scored; the latest night's resting-HR range 54.0–76.6, SpO2 92.0–100.0.
- Counting from Oct 4: 7 days scored; resting HR 60.3–77.0, SpO2 95.0–100.0. The ranges now come from the Fitbit
  alone. The HRV range (3.9–45.6) stays wide because of the 5 ms spread floor (audit R4), not the device mix.
