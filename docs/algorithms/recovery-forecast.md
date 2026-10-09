# Recovery forecast

Code: `src/core/scoring/forecast.ts` (a port of noop's `RecoveryForecast.kt`, marked APPROXIMATE); the shared load
helpers are in `src/core/scoring/load.ts`. Tests: `forecast.test.ts`, and "forecast strain nudge on the seed" in
`pipeline.test.ts`.

The forecast estimates tomorrow morning's Recovery, shown as "Tomorrow's forecast" with a ± band. It is a rough
guide, not a model of your physiology.

## Formula

    forecast = clamp(baseline + strain + sleep + trend, 0, 100), rounded

- **baseline:** the mean of your last 14 Recovery scores. It needs at least 5.
- **strain** (*changed in scoring version 12*): −3 × the Day Strain points today's load (TRIMP so far) goes above your
  typical training session, capped at −12. It is never positive. A rest day, a routine session, or a day you haven't
  trained yet all give 0. The typical session is the one Strain Target uses: the median of the training days in the
  28 days before today.
- **sleep:** 14 × (planned sleep ÷ need − 1). Planned sleep is tonight's Peak need. The ratio part is clamped to
  [−1, +0.25].
- **trend:** −(least-squares slope of the 14 scores), clamped to ±8. A run of rises or falls is eased back.
- **band:** max(the SD of the 14 scores, 8). Add 6 with fewer than 10 scores.
- **confidence:** "solid" with 10+ scores and a sleep need informed by 7+ nights; otherwise "building".

**In the pipeline** (`forecastOf`, `scores.ts`) no forecast is made before **14 scored days**, a stricter gate than the
function's 5. So in the app the "+6 with fewer than 10 scores" band widening never applies, and "building" appears
only if the sleep need has fewer than 7 nights behind it. The 5-score minimum and the widening matter only to direct
callers and tests.

**What "planned sleep" contains.** Tonight's Peak need is the Sleep Planner's need: baseline + strain + 0.2 × debt −
today's naps ([sleep-planner](sleep-planner.md)). So:
- sleep debt *raises* planned sleep, and with it the forecast, though debt means worse sleep so far;
- a nap today *lowers* it;
- planned ÷ need is 1 or more on almost every day without a nap, so the term rarely goes negative.

The term reflects the plan, not how you are likely to sleep.

## Why the strain term changed

noop's term was −9 × (today's Effort − the 14-day average Effort) ÷ 12, clamped to ±12. It was tested on the real
function and the 180-day demo database.

**1. It read today's running total as a finished day.** The forecast is recomputed during the day. For someone who
trains in the evening:

| Time | Load so far | Old nudge | New nudge |
|---|---|---|---|
| 08:00 | 2 | **+12** | 0 |
| 12:00 | 5 | **+12** | 0 |
| 17:00 | 8 | **+12** | 0 |
| 19:00, after a usual session | 120 | −9 | 0 |
| after a session twice as hard | 236 | −12 | −5 |

The old term made "Tomorrow's forecast" swing by 21 points in one day.

**2. It compared with your average day, rest days included.**
- An ordinary rest day got +12, and an ordinary session −9.
- A daily trainer's identical session got 0, because their average has no rest days.
- The new term compares with your typical session, so it means the same for every kind of trainer. 2× your session
  gives −5 and 3× gives −8 for all of them (a test).

**3. It made the forecast less accurate.** Mean absolute error against the next morning, over 154 seed days:

| Strain term | Error | Active on |
|---|---|---|
| noop's (two-sided vs the average day) | 18.80 | 154 days, at the ±12 cap on 50 |
| None | 16.95 | — |
| One-sided vs the average day | 17.83 | 74 |
| **One-sided vs the typical session, −3 per point (chosen)** | **16.88** | 33 |

On the seed, the relation between today's Effort excess and tomorrow's surprise was +1.2 points per 12 Effort points
(r = 0.07), not −9.

**Why −3, and why it is uncalibrated.**
- The seed generator makes a hard day lower the next night's HRV by only about 2 % per unit of training. Every size
  from −1 to −5 per point scored the same (16.92–16.96), so the seed cannot choose one.
- −3 keeps the expected direction (a much harder day lowers tomorrow) at a modest size.
- Re-check it on real Fitbit data: compare next-morning Recovery after days above the typical session with the
  forecast.

## Constants

| Constant | Value | Kind |
|---|---|---|
| `baselineWindow` / `minBaselineNights` | 14 / 5 | noop |
| `strainPointsPerRecovery` | 3 | Pulse v12; *tunable*, uncalibrated |
| `strainAdjCap` | 12 | noop (now one-sided) |
| `sleepWeight` / `sleepOverCap` | 14 / 0.25 | noop |
| `reversionWeight` / `reversionAdjCap` | 1 / 8 | noop |
| `minBandPoints` / `thinBandPoints` / `trustedNights` | 8 / 6 / 10 | noop |

## Tests

- **`forecast.test.ts`:**
  - the noop cases, with the strain inputs renamed (the sleep, trend, band and confidence parts are unchanged);
  - never positive (rest day, partial days, a routine session);
  - 2× → −5, 3× → −8;
  - the −12 cap;
  - trainer-independent;
  - the evening-session day stays at 0.
- **`pipeline.test.ts`:**
  - on the seed, the stored forecast is never above the same forecast without a strain term;
  - its error is no worse than leaving the term out (+0.1 tolerance).

## Sources

- noop (`ryanbr/noop`), `RecoveryForecast.kt`: the baseline, sleep and trend terms, and the band.
