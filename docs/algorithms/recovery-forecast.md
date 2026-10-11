# Recovery forecast

Code: `src/core/scoring/forecast.ts` (a port of noop's `RecoveryForecast.kt`, marked APPROXIMATE); the shared load
helpers are in `src/core/scoring/load.ts`. Tests: `forecast.test.ts`, `forecast.sim.test.ts`, and "forecast strain nudge on
the seed" in `pipeline.test.ts`.

The forecast estimates tomorrow morning's Recovery, shown as "Tomorrow's forecast" with a ± band. It is a rough
guide, not a model of your physiology.

## Formula (scoring version 38)

    level    = (n × mean(last 60 scores) + 60 × 58) / (n + 60)            n = scores in that window
    φ̂       = clamp((m × r1 + 10 × 0.3) / (m + 10), 0, 0.6)              r1 = lag-1 autocorrelation of the last 60 (m) scores
               at least 0.6 while the illness hold runs
    forecast = clamp(level + φ̂ × (today − level) + strain + sleep, 0, 100), rounded

- **level:** your usual Recovery. Recovery is scored against your own normal, so everyone's long run sits near the
  population mean of 58; the 60-day mean is drawn toward 58 as if 60 more days sat there, so a short history is mostly
  58 and a long one mostly yours.
- **φ̂ (persistence):** how much of today's distance from your level carries into tomorrow. It is your own lag-1
  autocorrelation, held toward 0.3 (with the weight of 10 days) and kept within 0–0.6. While the illness hold runs
  (`RecoveryRow.heldBaseline`; [baselines](baselines.md) § Why version 30) it is at least 0.6: a sick day is likely
  followed by another.
- **strain** (*since scoring version 12*): −3 × the Day Strain points today's load (TRIMP so far) goes above your
  typical training session, capped at −12. It is never positive. A rest day, a routine session, or a day you haven't
  trained yet all give 0. The typical session is the one Strain Target uses: the median of the training days in the
  28 days before today.
- **sleep** (*since version 38*, `sleepNudge`): what Recovery's own sleep term would add to the forecast if tonight's
  Sleep Performance is the mean of your last 3 nights: z = (that − your usual night) ÷ 0.12, moved through the
  logistic at weight 0.15, the same centre (`personalSleepCentre`) and scale Recovery uses. A run of poor nights takes
  points off (3 nights 12 points under your usual: about −3 at a 58 forecast); a usual run is 0. It needs 3 nights.
  Sleep debt and naps don't enter it.
- **band:** max(the SD of the last 14 scores, 8). Add 6 with fewer than 10 scores.
- **confidence:** "solid" with 10+ scores and 7+ nights of Sleep Performance; otherwise "building".

**In the pipeline** (`forecastOf`, `scores.ts`) no forecast is made before **14 scored days**, a stricter gate than the
function's 5. So in the app the "+6 with fewer than 10 scores" band widening never applies. The 5-score minimum and the
widening matter only to direct callers and tests. The forecast keeps `baseline` (the level), `phi`, `expectedSleepPerf`
and `sleepAdj`.

**The floor.** Most of each morning's Recovery is that night's own noise, so no forecast gets far below about 17
points of mean error. The aim is to stop being worse than trivial guesses, and to stop being wrong in a fixed direction
around illness and sleep.

## Why version 38: a trend that pushed the wrong way, and a sleep term fed the plan (audit R7, R9)

**R7: the trend term.** Version 37 was the 14-day mean minus its slope (capped ±8). The mean already lags; subtracting
the slope pushed it further from where you were. On simulated people (`forecast.sim.test.ts`: 60 people × 200 nights,
scored and folded as stage 2 does, the illness hold included, no strain, forecasts from night 30), mean error against
the next morning:

| Scenario | v37 | 14-day mean | Constant 58 | **v38** |
|---|---|---|---|---|
| Day-to-day independent (φ 0) | 19.15 | 19.12 | **18.54** | 18.74 |
| Typical (φ 0.4) | 19.39 | 19.17 | 18.65 | **18.31** |
| Slow-moving (φ 0.8) | 19.40 | 18.79 | 18.90 | **17.07** |
| Older, HRV 22 | 19.34 | 19.13 | 18.59 | **18.27** |
| Heavy-tailed nights | 19.78 | 19.55 | 18.95 | **18.58** |
| Periodic 5-night illnesses | 22.65 | 22.12 | 21.49 | **19.19** |
| Poor-sleep weeks | 19.50 | 19.27 | 18.72 | **18.37** |

- v37's trend term was worse than its own 14-day mean everywhere, and v37 never beat a constant 58.
- v38 beats both everywhere except fully independent days, where any personal estimate is noise: a constant 58 wins
  there by 0.2, and v38 still beats the 14-day mean.
- **Around a 10-night illness** (100 people), the forecast's mean signed error: during it **+30.2 → +18.9** (too high),
  the week after **−34.2 → −7.8** (too low).

**Options measured** (the same sim): a 28-day level lost to the constant by 0.4 on independent days, and a median
level was no better than the mean. Holding the level toward 58 helped every scenario. A fixed φ 0.3 lost 0.6 on
independent days against the personal φ̂. The illness override at φ 0.6 cut the during-illness error from 28.7 to 19.3
and the periodic-illness error by 0.5, for at most 0.09 on healthy scenarios; 0.8 cut it to 12.0 but cost 0.16 on
independent days; φ 1 cut it to 4.7 but cost 0.2–0.3 everywhere.

**R9: the sleep term was fed the plan.** Version 37's sleep term was 14 × (planned sleep ÷ need − 1), and "planned
sleep" was the Sleep Planner's need: baseline + strain + 20 % of debt − today's naps. So sleep debt *raised* the forecast
(600 min: +4), a nap *lowered* it (90 min: −3), a hard day's extra need partly cancelled the strain nudge, and actually
sleeping less could never show. On the seed it rose with debt on 37 evenings and fell after naps on 20.

Tomorrow's Recovery only feels last night's sleep through its sleep term, your Sleep Performance against your usual,
and Sleep Performance is scored against your need without debt. So the honest nudge is how tonight is likely to
score: like your recent nights. Forecast error with and without the nudge (version 38):

| Window | Poor-sleep weeks | Typical | Slow-moving | Periodic illness |
|---|---|---|---|---|
| None | 18.35 | 18.32 | 17.15 | 19.20 |
| 1 night | 18.36 | 18.37 | 17.11 | 19.11 |
| **3 nights (chosen)** | **18.33** | **18.31** | **17.04** | **19.17** |
| 7 nights | 18.37 | 18.31 | 17.08 | 19.19 |

The gain is small, as expected: tonight's sleep is mostly its own. The fix is mostly about direction.

**On the seed** (154 forecasts): mean error **17.34 → 17.09** (14-day mean 17.53; a constant 58 16.75, since the seed's
nights are close to independent). Recovery's own values, and every other score, are unchanged (`GOLDEN[38]`; parity
passes as recorded for version 37).

**On the owner's data:** Recovery starts on Oct 11 and the forecast after 14 scored days, so it can't be checked yet.

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
| `baselineWindow` / `minBaselineNights` | 14 / 5 (the band's window and the minimum history) | noop |
| `strainPointsPerRecovery` | 3 | Pulse v12; *tunable*, uncalibrated |
| `strainAdjCap` | 12 | noop (now one-sided) |
| `levelWindow` / `levelPriorNights` | 60 / 60, toward `populationMean` 58 | Pulse v38; *tunable* |
| `phiWindow` / `phiPrior` / `phiPriorNights` / `phiMax` | 60 / 0.3 / 10 / 0.6 | Pulse v38; *tunable* |
| `phiIllness` | 0.6 | Pulse v38; *tunable* |
| `sleepRecentNights` / `minSleepNights` / `solidSleepNights` | 3 / 3 / 7 | Pulse v38; *tunable* |
| `minBandPoints` / `thinBandPoints` / `trustedNights` | 8 / 6 / 10 | noop |

## Tests

- **`forecast.test.ts`:**
  - the noop band, strain and range cases (the trend and planned-sleep cases replaced in version 38);
  - *v38:* level + φ̂ × (today − level), hand-computed; φ̂ held toward 0.3 and clamped; the illness override; the sleep
    nudge by hand, 0 on a usual run, none under 3 nights, and no debt or nap input;
  - never positive (rest day, partial days, a routine session);
  - 2× → −5, 3× → −8;
  - the −12 cap;
  - trainer-independent;
  - the evening-session day stays at 0.
- **`forecast.sim.test.ts`** (*v38*): no worse than the 14-day mean and better than v37 by 0.3+ in every scenario; within
  0.25 of a constant 58 on independent days and better elsewhere; the illness errors; the sleep nudge helps in
  poor-sleep weeks and costs at most 0.1 elsewhere.
- **`pipeline.test.ts`:**
  - on the seed, the stored forecast is never above the same forecast without a strain term;
  - its error is no worse than leaving the term out (+0.1 tolerance).

## Sources

- noop (`ryanbr/noop`), `RecoveryForecast.kt`: the original baseline, sleep and trend terms, and the band (the band is
  still noop's).
