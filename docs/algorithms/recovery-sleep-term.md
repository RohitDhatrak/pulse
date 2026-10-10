# Recovery: the sleep term

Code: `src/core/scoring/recovery.ts` (`personalSleepCentre`, the sleep term in `recovery()`), `drivers.ts` (the
SLEEP_QUALITY row) and `src/server/pipeline/scores.ts` (`scoreRecovery`). Tests: `recovery.test.ts`,
`drivers.test.ts`, and "Recovery's sleep centre on the seed" in `pipeline.test.ts`.

Recovery mixes how last night went against your normal: HRV (weight 0.55), resting HR (0.20), sleep (0.15),
respiration and skin temperature (0.05 each). This page is about the sleep part.

`recovery()` also accepts two more terms ported from noop, a recovery index (`recoveryIndexSlope`, weight 0.05) and
activity balance (weight 0.05). The pipeline never passes them, so they never count. Missing terms renormalise, so
the weights above are the ones in use.

## Formula (scoring version 17)

    z_sleep = (sleepPerf − centre) / 0.12            weight 0.15

- `sleepPerf` is last night's Sleep Performance ÷ 100. Without one, it is the main sleep's efficiency.
- **`centre` = your own average `sleepPerf` over the last 28 earlier values** (`personalSleepCentre`).
  - They are the last 28 nights *that had a value*, not the last 28 calendar nights: nights with no main sleep are
    skipped, so with gaps the window reaches further back.
  - With fewer than 7 values it is noop's fixed **0.85**.
  - Every night with a `sleepPerf` counts, including the efficiency fallback. That includes **nights Recovery did not
    score**: unstaged nights, nights without HRV and nights while the baseline calibrates (`scoreRecovery` pushes the
    value before deciding whether it can score). Unstaged nights score low on Sleep Performance, so they pull the
    centre down a little. *Since version 31* an unstaged night's Sleep Performance uses your usual restorative sleep
    instead of 0, so it no longer biases the centre ([sleep-need](sleep-need.md)).
  - *Since version 30* a night the illness hold holds (the second and later nights of an illness-ward run;
    [baselines](baselines.md)) is left out of the centre too, so an illness's bad sleep doesn't make the nights
    after it look good.
- **The scale stays the fixed 0.12** (12 Sleep Performance points per unit). Only the centre is personal.
- The centre is stored with each day as `recovery.inputs.sleepCentre`. The Recovery screen's sleep evidence shows it
  as the baseline.
- The **SLEEP_QUALITY driver row** measures its points against the same centre, and reports it as `baseline`.
  - Above it reads "Better sleep than your usual"; below it, "Sleep below your usual".
  - The verdict codes are unchanged: `STRONG_NIGHT_SUPPORTING` and `BELOW_GOOD_NIGHT_LIMITING`.

Before version 17, the centre was always 0.85: a fixed "good sleeper", while HRV, resting HR, respiration and skin
temperature are all measured against your own normal.

## Why

**The problem: a permanent offset.** The real `rest()` (with the version 15 sleep need) and the real `recovery()`,
everything else at baseline, 60 nights each:

| Sleeper | Usual sleep score | Recovery shift every day, fixed 0.85 | Night-to-night signal |
|---|---|---|---|
| Good (7.5 h, 92 % efficiency, SRI 85) | 90.1 | **+2.7** | ±1.5 |
| Typical (7 h, 88 %, SRI 78) | 86.9 | +1.0 | ±1.7 |
| Older adult (7 h, 85 %, deep 8 %) | 81.1 | **−2.1** | ±1.7 |
| Restless (6.5 h, 80 %, SRI 70) | 79.5 | **−3.0** | ±2.1 |

- **The offset was as large as the term's whole daily signal.** It mostly shifted some people's Recovery up or down
  for good.
- **Older adults lost about 2 points a day** for age-normal deep sleep. The sleep score's fixed 13 % deep target is a
  separate open issue (research review 4.4).
- **On the demo data,** the average sleep performance was 0.916, so every day got a hidden bonus of about +2.8.

**The fix list's design was rejected.** It proposed scoring sleep against your own baseline like HRV: a z-score
divided by *your* night-to-night spread. Your own sleep score barely varies (about ±3 points), so that would turn
small dips into large z-scores:
- ordinary nights would swing Recovery ±5–7 points;
- one bad night (5 h at 75 % efficiency) would cut it by **33–40 points**;
- sleep would overpower HRV (a test documents this).

**The chosen design.** A personal centre with the fixed scale, on the same simulated nights:

| Sleeper | Permanent offset | Night-to-night signal | A bad night (5 h, 75 %) |
|---|---|---|---|
| Good | −0.2 | ±1.5 | −9.9 |
| Typical | −0.3 | ±1.7 | −8.1 |
| Older adult | −0.3 | ±1.7 | −7.8 |
| Restless | −0.5 | ±2.1 | −5.7 |

- The offset disappears; the daily signal and the response to a bad night stay as they were.
- A bad night costs a little less for a restless sleeper, because it is less unusual *for them*.
- **The trade-off:** someone who chronically sleeps badly no longer carries a permanent Recovery penalty. Their Sleep
  Performance still shows it every day.

**On the demo database:**
- Recovery fell by 2.8 on average (0.3 to 3.8 on any day): the hidden bonus, removed.
- The mean is 57.1, close to the 58 that "everything at your normal" maps to.
- Bands went from 19 / 89 / 62 to 23 / 93 / 54 (red / yellow / green) out of 170 days.
- Sleep and Strain are byte-identical (parity).

## Recovery without its sleep term (scoring version 20)

**What it is.** The pipeline also stores `recovery.withoutSleep`: the same score with the sleep term left out and the
other terms renormalised (`recovery()` with no `sleepPerf`).
- It is not shown.
- The Energy Bank starts from it, plus 0.4 × sleep performance, so last night's sleep counts once there. See
  `energy-bank.md` § "Why version 20".

**It is a weighted average, not "Recovery minus sleep".** When the sleep term sits below the body terms' average, the
value without it is *higher*.

## Constants

| Constant | Value | Kind |
|---|---|---|
| `sleepPerfCenter` | 0.85 | noop; since version 17 only the cold-start centre |
| `sleepPerfScale` | 0.12 | noop; unchanged |
| `sleepCentreWindow` | 28 nights | version 17 (as the sleep need) |
| `minSleepCentreNights` | 7 | version 17 (as the sleep need) |
| `wSleep` | 0.15 | noop; unchanged |

## Tests

- **`recovery.test.ts`:**
  - `personalSleepCentre` (0.85 under 7 nights; the mean of the last 28; older nights ignored);
  - a centre shifts the term exactly like shifting the score;
  - without one, noop's 0.85 stays;
  - **a 4-sleeper simulation:**
    - the fixed centre's offset is at least 1 point;
    - the personal centre's is at most 0.8;
    - the swing changes by no more than 0.2;
    - a bad night costs 4–12 points;
  - the rejected personal-z design swings ordinary nights by more than 4 points.
- **`drivers.test.ts`:**
  - SLEEP_QUALITY is 0 points and a typical night at the centre, with the centre as its baseline;
  - the verdicts are relative to it;
  - with no centre, noop's 85.
- **`pipeline.test.ts`:** on the seed, the stored centre is 0.85 for the first 7 nights, then exactly the mean of the
  prior 28 nights' `sleepPerf`.

## Sources

- noop (`ryanbr/noop`), `RecoveryScorer.kt`: the weights, the 0.85 and 0.12, and the logistic.
- Pulse's research review, `docs/research/recovery-readiness.md`: the sleep-term row (a personal centre, or fitting
  0.85 / 0.12 on real data).
