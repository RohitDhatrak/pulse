# Sleep need

Code: `src/core/scoring/sleep.ts` (`personalizedNeedHours`, `populationNeedFloorHours`; the debt ledger, `ledger`,
`creditedSleepMin`, `awakeAllNight`). Tests: `sleep.test.ts`, `sleep.allnighter.sim.test.ts`, a plan case in
`sleepPlanner.test.ts`, and "sleep need on the seed" and "a night spent awake" in `pipeline.test.ts`.

Sleep need is how much sleep, in hours **asleep** (not in bed), you need on a normal night. Everything about sleep
is judged against it.

```mermaid
flowchart LR
  N["Main-sleep hours, the 28 nights before"] --> Q{"≥ 7 nights?"}
  Q -->|no| D["7.5 h, or the floor if higher"]
  Q -->|yes| M["Median of those nights"]
  M --> F["At least the floor: 7 h adults, 8 h at 13–17, 9 h to 12, sliding by age; at most 9.5 h"]
  D --> NEED[Sleep need]
  F --> NEED
  NEED --> S["Sleep score: duration = asleep ÷ need (50 %)"]
  NEED --> L["Debt: debt = max(0, 0.6 × debt + shortfall)"]
  NEED --> P["Sleep Planner: need + max(0, strain + 20 % of debt − naps) → bedtimes"]
```

## Formula (since scoring version 15; the hold since version 40)

1. Take the main-sleep hours of the last 28 nights. Nights of 0 or less are ignored.
2. With fewer than 7 nights, the need is `max(7.5, floor)`.
3. Otherwise it is the **median** of those nights (`needQuantile = 0.5`, linearly interpolated), then:
   - at least the floor (`populationNeedFloorHours`, by exact age since version 42): the lower bound of each
     guideline range, **7 h** for adults (and an unknown age), **8 h** for 13–17 and **9 h** to 12, sliding linearly
     across 12–13 (9 → 8) and 17–19 (8 → 7);
   - at most 9.5 h.
4. *Since version 40,* **held** (`heldNeedHours`): tonight's need is the larger of that and yesterday's need less
   0.5 minutes (`needFallPerNightMin`). It rises at once and falls at most about 15 minutes a month. Only a learned need
   is held: the 7.5 h default before 7 nights isn't. (Versions 40–41 also restarted it on a new age floor, 9 → 7 h at
   18; since version 42 the floor moves at most 1 h a year, slower than the hold falls, so the hold follows it.)
   - The Sleep Planner sets it each evening (`scorePlanner`), and the next morning's Sleep Performance and debt use
     that same value (`scoreSleep`), so the plan and the score agree.

**Debt** (`ledger`, *since version 40*): over the last 14 nights with sleep, each night
`debt = max(0, 0.6 × debt + need − slept)`, where a night 30 minutes or less short adds nothing (`DEBT_TOLERANCE_MIN`)
and anything under 10 minutes clears. Before version 40 it was `0.55 × max(0, need + debt − slept)`.

Before version 15, it was the **upper quartile** (0.75), floored at **8 h**, and 8 h before 7 nights.

`defaultSleepNeedHours` (7.5) is also the default argument of `rest`, `ledger`, `debtSeries`, `restFromTotals` and
the forecast's `defaultNeedHours`. The pipeline always passes the personal need, so those defaults only matter to
direct callers and tests. noop's 8 h test cases now pass 8 explicitly.

## Why it changed

**The problem.** A healthy adult who reliably sleeps 7 h, inside the AASM / NSF 7–9 h range, was judged against
8 h:
- **73 minutes of permanent sleep debt**;
- a sleep score held at 85 (91.4 is the best reachable at 88 % efficiency);
- a Sleep Planner telling them to spend **9.4 h in bed** (bedtime 21:38 for a 07:00 wake).

**A second cause.** With ordinary night-to-night variation, the upper quartile kept everyone short of their own better
nights, whatever the floor. It also let one sick or catch-up week raise the need for the next month.

Simulated with the real `rest`, `ledger` and `sleepPlan`, 88 % efficiency, nights 30–45 of 60. Each cell is debt in
minutes / sleep score / planned hours in bed:

| Rule | 6.5 h steady | 7 h steady | 7.5 h steady | 8 h steady |
|---|---|---|---|---|
| v14: floor 8, upper quartile | 110 / 82.0 / 9.5 | **73 / 85.2 / 9.4** | 37 / 88.3 / 9.2 | 0 / 91.4 / 9.1 |
| Fix list: floor 7, upper quartile | 37 / 87.8 / 8.1 | 0 / 91.4 / 8.0 | 0 / 91.4 / 8.5 | 0 / 91.4 / 9.1 |
| Floor 7.5, median | 73 / 84.7 / 8.8 | 37 / 88.1 / 8.7 | 0 / 91.4 / 8.5 | 0 / 91.4 / 9.1 |
| **v15: floor 7, median** | 37 / 87.8 / 8.1 | **0 / 91.4 / 8.0** | 0 / 91.4 / 8.5 | 0 / 91.4 / 9.1 |

Sleepers varying ±0.5 h a night (one simulated person per cell, the test's seed). In brackets: the debt after 5 nights
1.5 h short.

| Rule | 6.5 h | 7 h | 7.5 h | 8 h |
|---|---|---|---|---|
| v14 | 107 / 82.6 / 9.5 (213) | 70 / 85.7 / 9.4 (176) | 33 / 88.5 / 9.2 (139) | 17 / 89.7 / 9.5 (124) |
| Fix list | 33 / 88.1 / 8.1 (139) | 17 / 89.4 / 8.3 (124) | 17 / 89.5 / 8.9 (124) | **17 / 89.7 / 9.5** (124) |
| Floor 7.5, median | 70 / 85.3 / 8.8 (176) | 33 / 88.3 / 8.6 (139) | 3 / 90.5 / 8.5 (105) | 3 / 90.7 / 9.0 (100) |
| **v15** | 33 / 88.1 / 8.1 (139) | **3 / 90.4 / 8.0** (105) | 3 / 90.6 / 8.5 (100) | 3 / 90.7 / 9.0 (100) |

- **The fix list's change alone** (floor 7) fixes perfectly steady sleepers, but leaves everyone who varies about
  17 min short. A healthy 8 h sleeper is still told to spend 9.5 h in bed.
- **v15** leaves the test's healthy 7–8 h sleeper with about 3 min of debt (under the 10-minute band, which counts as
  none). That is one seed. Across 200 simulated people varying ±0.5 h (Gaussian), the average debt is **9–10 min**
  (P90 16–18 min), and **debt shows (10 min or more) on about 40% of days**. The median need sits at the middle of
  your nights, so a run of below-median nights tips into a small debt that comes and goes. This is a known
  trade-off of the median. *Version 40* keeps it about the same (35 % of days, about 15 min on average) while making
  chronic restriction visible (§ Why version 40).
- **It still works where it should:**
  - a 6.5 h sleeper, below the recommended range, still carries about 33 min;
  - 5 short nights still raise debt to 100–139 min.
- **Robustness** (a test): 5 sick nights of 9.5 h barely raise the need 6 nights later, and raise it less than the
  upper quartile does. The test checks one steady (±0.3 h) sleeper, whose lift is at most 0.3 h. Across 200 people:
  - steady (±0.3 h) sleepers: median +0.07 h, P90 +0.16, worst +0.31;
  - more varied (±0.5 h) sleepers: median +0.12 h, P90 +0.27, worst +0.5.

**On the demo database** (180 days):

| | v14 | v15 |
|---|---|---|
| Days with sleep debt | 167 | 52 |
| Median debt | 44.5 min | 0 min |
| Mean sleep score | 88.8 | 91.6 |
| Mean Recovery | 58.8 | 59.9 (at most +2.4 on any day, through its sleep term) |

Strain is byte-identical.

**The evidence, and the decision.**
- AASM / SRS (Watson 2015) say adults need **at least 7 h**. The NSF (Hirshkowitz 2015) recommends 7–9 h for ages
  18–64 and 7–8 h for 65 and over.
- Pulse's research review (`docs/research/sleep.md`) had argued for keeping 8 h for ages 18–64, citing Kitamura 2016:
  in the lab, young men's optimal sleep was 8.4 h against a habitual 7.4 h, so habitual sleep may understate need.
- That was weighed and not adopted (owner's decision, 2026-10-07). A floor above the guideline minimum puts most
  healthy sleepers in permanent debt and pushes 9+ h in bed.
- A user who really needs more shows it: the median follows their own longer nights.

## Why version 40: chronic short sleep was absorbed in about three weeks (audit S4)

**Two mechanisms hid it.**
- **The need followed the habit.** The median of 28 nights becomes your new length within about 15 nights, so an 8 h
  sleeper cut to 7 h had a 7 h need, and about 10 minutes of debt, by week 3. Sleep need is a fairly stable trait in
  adults: chronic restriction shortens sleep, not need.
- **The ledger forgot.** `0.55 × max(0, need + debt − slept)` wrote 45 % of each night's shortfall off at once and
  halved the rest nightly, so a steady shortfall s never read more than 1.22 × s. `docs/research/sleep.md` #3: deficits
  accumulate over weeks (Van Dongen 2003; Belenky 2003; Kitamura 2016).

**The change.**
- **The need is held:** it rises at once and falls at most 0.5 minutes a night.
- **The ledger:** carries 60 % and adds each night's whole shortfall, ignoring nights within 30 minutes of the need.

**How it was tested** (`sleep.need.sim.test.ts`). 200 people per case, each with their own usual length (±0.2 h) and Gaussian nights. Each day runs as the pipeline does it, with v39's need and ledger kept as a reference.

| | v39 | v40 |
|---|---|---|
| Ordinary 7.5 or 8 h sleepers (± 0.5 h): days with debt, mean debt | 38 %, 9 min | 35 %, 15 min |
| Steady 7.5 h sleepers (± 0.3 h) | 22 %, 4 min | 11 %, 3 min |
| 7 h sleepers at the floor (± 0.5 h) | 49 %, 13 min | 44 %, 21 min |
| 8 h → 7 h: debt in weeks 3 and 8 | 16, 10 min | **118, 70 min** |
| 8 h → 7 h: need in week 8 | 7.09 h | **7.56 h** |
| 7.5 h → 6.5 h: debt in week 8 | 37 min | 80 min |
| A lasting half-hour change: debt in week 12 | 7 min | about 10 min |
| 5 sick nights of 9.5 h: need a week / a month later | +4.8 / +0 min | +4.7 / +2.4 min |
| One all-nighter clears in | 6 nights | about 7 nights |

- **The constants were swept.** Carry 0.7–0.8, the research doc's suggestion, showed restriction even more strongly
  (160+ min in week 8). But every ordinary night below need adds to a debt that can't go below zero, so ordinary sleepers
  read debt on 60–65 % of days. A tolerance of 30 minutes (about one night-to-night SD) with 0.6 kept them at v39's
  level.
- **The Sleep Planner's time in bed never passes its age cap** in the 8 → 7 h case (a test). It repays 20 % of the
  debt a night.
- **The cost:** a genuine lasting drop in need takes months to be accepted: an 8 → 7 h change is fully absorbed after
  about 4.5 months. Erring towards "you may be short" is the safer side.

**On the seed** (180 days):

| | v39 | v40 |
|---|---|---|
| Days with debt | 52 | 40 |
| Median / mean debt | 0 / 8.9 min | 0 / 15.1 min |
| Largest debt (the seed's short stretches) | 135 min | 286 min |
| Mean sleep score | 91.56 | 91.40 (61 nights moved, at most 1.1) |

Recovery moved by at most 0.44 through its sleep term, and the planner never hit its cap.

**On the owner's data** (Oct 4–10, a local copy): the need is still the 7.5 h default (fewer than 7 nights). Debt
reads higher on short nights: 153 minutes after the 5.4 h night of Oct 8 (v39: 83), 50 the next morning (v39: 22.5).

## Why version 42: the teen floor (audit S7)

**The problem.** The adult floor is the bottom of the 7–9 h guideline range (version 15), but under 18 it was 9 h, the
middle of the 8–10 h teen range, and it stepped to 7 h on the 18th birthday.
- 16-year-olds sleeping 8.5 ± 0.4 h, well inside their guideline, carried **63 min** of debt on average, on 85 % of
  days, and the planner sent them to bed about 20:30.
- On the 18th birthday the same 8 h nights went from a 9 h need to 8 h and from about **143 min** of debt to 10 the
  next morning (the audit measured 75 → 0 under the version 39 ledger).

**The change.** `populationNeedFloorHours` takes the exact age (`d.age.years`) and returns each guideline range's lower
bound: 9 h to 12, 8 h for 13–17, 7 h from 19, sliding linearly across 12–13 and 17–19. It never changes by more than
0.003 h a day, under the held need's 0.5-minute fall, so the version 40 hold no longer restarts on a new floor and the
`needFloor` fold field is gone.

**Measured** (`sleep.need.sim.test.ts`, 200 people per case, days 40 on):

| Case | Version 41 | Version 42 |
|---|---|---|
| 16, sleeping 8.5 h: mean debt | 63 min (85 % of days) | **8.8 min** (25 %) |
| 16, sleeping 7.5 h (under the 8 h floor): mean debt | 225 min | **62 min**, still shown |
| 8 h sleepers turning 18: biggest one-day change in mean debt | 133 min (143 → 10) | **4 min** |
| … in mean need | 60 min | **0.2 min** |

Adults are unchanged: from 19 the floor is 7 h as before. No seed or owner value moved (both are adults).

## Why version 43: the restorative targets penalised normal ageing (audit S8)

**The problem.** The restorative part (20 % of Sleep Performance) is

```
min(100, (deep + REM share) / target) × (0.5 + 0.5 × min(1, deep share / deep target))
```

and its targets, 50 % and 13 %, were the same at every age. Deep sleep declines with age, so healthy older sleepers
were marked down twice, through the share and through the deep factor. The audit's 70-year-old (7 % deep, 19 % REM)
got 40 of 100 restorative, against 72 for a typical wearable night at 35.

**The change.** `restorativeTargets(ageYears)` (exact age, `d.age.years`):

| Age | Deep target | Deep + REM target |
|---|---|---|
| to 40, or unknown | 13 % | 50 % |
| 50 | 11.05 % | 46 % |
| 60 and over | 9.1 % | 42 % |

It is linear between 40 and 60 and never raised for the young. The ratios 0.70 (deep) and 0.84 (deep + REM) are the
relative decline in Ohayon 2004's norms from 40 to 60 (slow-wave sleep about 14 → 10 %, deep + REM about 35 → 29.5 %).
Ratios, not the lab percentages, are applied because wrist staging reads differently from a sleep lab
(*assumption, tunable*). The 0.5 floor factor is unchanged, so very little deep sleep still costs up to half the
component at any age. The Sleep page's typical deep and REM ranges, and the restorative status (40 / 30 %), scale by
the same factors.

**The evidence is mixed.** Ohayon 2004 (a meta-analysis across the lifespan) finds slow-wave sleep falls with age to
about 60; Boulos 2019 (normative PSG in healthy adults) finds no significant change in N3. Easing the target only from
40, by at most 30 %, and keeping the floor factor, is the cautious reading: a young person's score is untouched, and
an older one with genuinely little deep sleep still scores low.

**Measured** (`sleep.restorative.sim.test.ts`: 200 people per age, deep and REM following Ohayon's slopes scaled to a
Fitbit-like 15 % deep at 35, the same duration, efficiency and consistency at every age):

| | Version 42 | Version 43 |
|---|---|---|
| Mean Sleep Performance at 35 / 50 / 70 | 88.4 / 86.3 / 84.7 | 88.4 / 87.8 / 87.9 |
| 70-year-old's restorative component | 54 | 70 |
| A 70-year-old with half the usual deep, Sleep Performance | 81.3 | 83.7, still 4.1 below a healthy 70-year-old |

The audit's night: restorative 40 → 55, about +3 points of Sleep Performance. In these norms version 42's gap was
3.6 points, smaller than the audit's 9, which used a 7 % deep night against a younger reference with more deep sleep.

**Seed and owner.** The seed is 36, so nothing moved. Recomputed as a 70-year-old (`pipeline.test.ts`), its mean
Sleep Performance rises 91.4 → 94.2 (its deep sleep is a 36-year-old's), and need, duration and efficiency are
unchanged.

## Sleep debt: which nights count (scoring version 25)

**The ledger.** Over the last 14 nights with a value, each night: debt = 0.55 × max(0, need + debt − slept), and under
10 min clears to 0 (`ledger`). A night's "slept" is `creditedSleepMin`: the main sleep's minutes plus the previous
day's naps.

**null vs 0.**
- **null** is a night without data, and the ledger skips it. That covers no main sleep (the band off, a session not
  yet synced, a night Fitbit missed) and a main sleep with 0 minutes asleep.
- **0** is a measured night without sleep, and **counts** (*since version 25*). noop skipped 0 as well; Pulse never
  passes 0 for missing data.

### A night spent awake

**The problem (before version 25).** An all-nighter has no sleep session, so it was null and skipped. The worst night
added no debt, while a 1 h night added about 214 min (0.55 × (450 − 60) at 7.5 h). The Sleep screen also said
"band not worn".

**Why not count every night without a session.** Most nights without a session are nights without data. Counting
them as 0 would invent about 4 h of debt after every band-off night, and every morning before the night syncs. So a
night counts as spent awake only with **positive evidence** over its core, local 00:00–06:00 (`awakeAllNight`):
1. no sleep session of any kind touched 00:00–06:00 (main or nap, processed or not, from either wake day);
2. the band was worn: at least **300 of the 360 minutes** have heart rate (`wornMin`);
3. the median minute HR is at least **resting + 5 bpm** (`hrAboveRest`). Resting is the usable resting-HR baseline,
   else the day's resting HR;
4. at least **100 steps** (`minSteps`): up and about, not lying in bed.

Stage 1 stores the core's summary on each day (`strain.night`: `hrMinutes`, `medianHr`, `steps`; `nightSummary`).

**How the thresholds were chosen.** 00:00–06:00 was simulated minute by minute, 2,000 nights per class, through the
real functions. Assumptions:
- Google's resting HR ≈ sleeping HR + 3;
- awake and seated is 8–16 bpm over sleeping HR (4–8 for a low riser: beta-blockers, some older adults);
- half of sleeping nights have one bathroom trip of about 50 steps;
- a night up at a desk has a trip to the kitchen now and then.

| Rule (share of nights called "awake") | Asleep: ordinary / alcohol / sick / high fever / insomnia | Up at a desk | Up and active | Up, low HR rise |
|---|---|---|---|---|
| median ≥ resting + 8 | 0 / 21 / 26 / 79 / 0 % | 63 % | 100 % | 4 % |
| steps ≥ 300 | 0 % for all | 58 % | 100 % | 61 % |
| median ≥ resting + 8 *or* steps ≥ 300 | 0 / 21 / 26 / 79 / 0 % | 86 % | 100 % | 62 % |
| **median ≥ resting + 5 and steps ≥ 100** (chosen) | **0 % for all, fever included** | **88 %** | **100 %** | 24 % |

**Why this rule.**
- A wrong call needs a sleeping night with its session missing *and* passing the rule. HR alone can't tell a
  feverish sleeper from someone up at a desk, but sleepers don't take 100 steps.
- The chosen rule called no sleeping night "awake". So a night that hasn't synced yet, or that Fitbit missed, stays a
  night without data, as before.
- The nights it misses (a small HR rise, or very still) also stay without data: never worse than version 24.

**What changes after a night spent awake:**
- **Debt:** the night counts as 0 + the previous day's naps. At a 7.5 h need with no debt before, that is
  0.55 × 450 = 247.5 min, now more than the 1 h night's 214.5 (a test checks debt never falls as sleep falls).
- **Sleep need** is unchanged: the night isn't added to the 28 nights behind the median.
- **The Sleep screen** shows "Up all night" (`no_sleep`) for Sleep Performance and the night's vitals, and the debt
  for that day. Recovery shows "No HRV last night" instead of "band not worn".
- **Tonight's Sleep Planner** grows with the debt, within the version 24 time-in-bed cap.

**On the seed** no night qualifies (its nights without a session are band-off nights, with no HR), so the seed's debt
is unchanged.

**End to end on a copy of the seed** (a test), one night's session is deleted and up-and-about HR and steps written
over 00:00–06:00. That day reads `no_sleep`, its debt matches the ledger and rises by more than 150 min, and the next
day carries it. The control (session deleted, sleeping HR left) stays a night without data.

## Sleep Performance on a night without stages (scoring version 31)

Sleep Performance (`rest()`, `src/core/scoring/sleep.ts`) is 0.5 duration + 0.2 efficiency + 0.2 restorative + 0.1
consistency. The restorative part, `restorativeScore`, is the (deep + REM) share against 50 %, scaled down when deep
is under 13 %. Since version 43 both targets ease with age from 40 (§ Why version 43).

**When Fitbit doesn't stage a main sleep** (`stagesStatus` not SUCCEEDED, so deep and REM are null):
- if at least **5** of the last **28** staged main sleeps have a restorative component, the night takes their
  **median**: your usual (`usualRestorativeNights`, `minUsualRestorativeNights`);
- with fewer, the restorative weight is left out and the other three are renormalised (÷ 0.8).

The Sleep row's `restorative` says which: "measured", "usual" or "omitted". The Sleep page then notes under the dial
"No sleep stages last night: restorative sleep counted at your usual." or "…: scored on duration, efficiency and
consistency."

A deep or REM total that is known to be 0 is measured, not missing.

### Why version 31

**The problem.** The pipeline passed missing deep and REM to `rest()` as 0, so an unstaged night scored 0
restorative and lost 9–16 points. A missing measurement was scored as a terrible one. Through `sleepPerf` that also
lowered the personal sleep centre Recovery is scored against (audit R11), which raised every staged night's Recovery,
and it reached the Energy Bank start, journal outcomes and reports.

**How it was tested.** 200 simulated people per group, each with their own deep and REM shares and 28 staged nights
behind them. Each test night was scored with its real stages (the truth), then as if unstaged. Short, fragmented
3–4.5 h nights, which Fitbit often can't stage, were included. Estimate − truth:

| Method | Young (deep 17 %): bias / MAE | Middle (13 %) | Older (8 %) | Short nights, MAE |
|---|---|---|---|---|
| Version 30 (deep = REM = 0) | −15.8 / 15.8 | −13.1 / 13.1 | −8.9 / 8.9 | 8.8–15.9 |
| Leave it out and renormalise | +2.4 / 3.1 | +5.0 / 5.2 | +9.2 / 9.2 | 3.2–4.4 |
| A fixed restorative of 75 | −0.8 / 2.7 | +1.9 / 3.2 | +6.1 / 6.3 | 2.7–6.3 |
| **Your median of recent staged nights** | **0.3 / 1.6** | **0.2 / 1.8** | **−0.1 / 2.0** | **1.6–2.0** |

- **Renormalising**, which the research review suggested (`docs/research/sleep.md`), implicitly gives everyone a
  restorative score equal to their other components. That credits older people with a young person's deep sleep
  (+9).
- **A fixed value** is wrong by age.
- **The person's own median** is unbiased for every group, and stays within 2 points on short nights too.
- Renormalising is kept only as the fallback when there's nothing personal to go on, and the page says so.

**On the seed** every main sleep is staged, so no score moved; only the new `restorative` field ("measured") was
added.

**End to end on a copy of the seed** (a test), one night is unstaged. It reads "usual" and lands within 5 points of
its staged score; version 30's rule lost more than 10. The next day's sleep centre moves by under 0.01.

## Constants

| Constant | Value | Kind |
|---|---|---|
| Adult floor | 7.0 h asleep | AASM / NSF lower bound (version 15; was 8.0) |
| Teen floor | 8.0 h for 13–17; 9.0 h to 12; linear across 12–13 and 17–19 | version 42; was 9.0 h under 18 (AASM / NSF: 8–10 h at 13–18, 9–12 h at 6–12) |
| `needQuantile` | 0.5 (median) | version 15; was 0.75 |
| `defaultSleepNeedHours` | 7.5 h | version 15; was 8.0; used before 7 nights |
| `minNeedNights` | 7 | unchanged |
| `maxNeedHours` | 9.5 | unchanged |
| Window | 28 nights | unchanged |
| `needFallPerNightMin` | 0.5 min | version 40; *tunable* (0.25 kept normal sleepers' need too high; 1 absorbed a 1 h cut within 8 weeks) |
| `DEBT_CARRY` | 0.6, with the whole shortfall added | version 40; was 0.55 × (need + debt − slept); *tunable* |
| `DEBT_TOLERANCE_MIN` | 30 min | version 40; *tunable* |
| `ON_TARGET_BAND_MIN` / ledger window | 10 min / 14 nights | unchanged |

## Worked examples (each is a test)

1. **A steady 7 h sleeper:** need 7.0, debt 0, duration score 100. The Sleep Planner's 100 % plan is 7 / 0.88 =
   7.95 h in bed, bedtime 23:03 for 07:00. Version 14: 73 min of debt, about 9.4 h in bed.
2. **Nights 8.0, 8.1 … 8.6:** need is the median, **8.3** (version 14: the upper quartile, 8.45).
3. **Fewer than 7 nights:** 7.5 h; at age 16, 8 h (version 41: 9 h); at age 10, 9 h.
4. **Chronic 6 h nights:** need 7 (the floor), so debt builds and the score shows the shortfall.

## Tests

- **`sleep.test.ts`:**
  - the floor by age;
  - the median on even and odd counts, ignoring nights of 0 or less;
  - the 7.5 h default and the 9.5 h cap;
  - *v40:* `heldNeedHours` (rises at once, falls half a minute a night); an 8 → 7 h sleeper's need over 140 nights; the
    new ledger by hand (60 % carry, the 30-minute tolerance, a 14-night 1 h shortfall reading 149.9 min);
  - a 45-night simulation:
    - a steady 7 h sleeper has no debt (version 14's 8 h need: 149.9 min under the v40 ledger, 73.3 under v39's);
    - healthy varied sleepers have ≤ 15 min (version 14: > 15 for an 8 h sleeper);
    - 6.5 h sleepers have ≥ 25 min;
    - 5 short nights give ≥ 90 min;
    - 5 sick nights move one steady sleeper's need ≤ 0.3 h, less than the upper quartile.
- **`sleepPlanner.test.ts`:** a 7 h sleeper's plan, 7.95 h in bed (version 14: > 9.3 h).
- **`sleep.need.sim.test.ts`** (*v40*): the table in § Why version 40, each against the v39 reference.
- **`pipeline.test.ts`:** on the seed, the stored need is ≥ 7 h, equals the held median of the prior 28 nights, is
  7.5 h in the first week, and each morning's need is the previous evening's plan need.
- **`queries/sleep.test.ts`:** the first-week need is 450 min.
- noop's 8 h cases (`ledger`, `rest`) pass 8 explicitly and keep their exact values.

## Sources

- Watson NF, et al. Recommended amount of sleep for a healthy adult (AASM / SRS). *Sleep* 2015.
- Hirshkowitz M, et al. National Sleep Foundation's sleep time duration recommendations. *Sleep Health* 2015.
- Ohayon MM, et al. Meta-analysis of quantitative sleep parameters from childhood to old age in healthy individuals.
  *Sleep* 2004. https://doi.org/10.1093/sleep/27.7.1255 (the version 43 ratios).
- Boulos MI, et al. Normal polysomnography parameters in healthy adults. *Lancet Respir Med* 2019 (no significant age
  change in N3; see § Why version 43).
- Paruthi S, et al. Recommended amount of sleep for pediatric populations: a consensus statement of the American
  Academy of Sleep Medicine. *J Clin Sleep Med* 2016. https://doi.org/10.5664/jcsm.5866 (9–12 h at 6–12, 8–10 h at
  13–18: the version 42 floors).
- Kitamura S, et al. Estimating individual optimal sleep duration and potential sleep debt. *Sci Rep* 2016 (weighed,
  not adopted; see above).
- noop (`ryanbr/noop`), `AnalyticsEngine.kt` `RestScorer` and `SleepDebt.kt`: the score and the debt ledger, ported
  in `src/core/scoring/sleep.ts`.
