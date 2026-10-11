# Sleep Planner

Code: `src/core/algorithms/sleepPlanner.ts`. Tests: `sleepPlanner.test.ts`, `sleepPlanner.sim.test.ts` (simulated
sleepers), "the Sleep Planner on the seed" in `pipeline.test.ts`, and `src/server/queries/plan.test.ts` (what the
screen shows).

The Sleep Planner answers "when should I go to bed tonight?". It works out tonight's sleep need, then counts back from your typical wake time for tomorrow, allowing for your usual sleep efficiency, to give bedtimes that deliver 100 %, 85 % and 70 % of that need.

**Since scoring version 24 time in bed is bounded.** Bedtimes never plan on less than 85 % efficiency, and time in
bed is capped by age. Before, the people who slept worst were sent to bed earliest: 12.6 h in bed and an 18:26
bedtime for someone sleeping 5 h at 60 % efficiency. See § Why version 24.

## Flow

```mermaid
flowchart TB
  BN[personalizedNeedHours] --> NEED[Need tonight]
  EF[Today's load so far vs your typical session] --> SA[+0.05 h per Day Strain point above it, up to 30 min]
  SA --> NEED
  DB[Sleep debt this morning] --> DR[+ debt × 0.2]
  DR --> NEED
  NAP[Today's nap minutes] --> NC["Offsets only the strain and debt extras (version 42)"]
  NC --> NEED
  N14[Last 14 main sleeps] --> WK{Tomorrow a weekend day?}
  WK --> WAKE["Median wake time on the 24 h clock, of nights of that kind like last night's (version 41)"]
  N14 --> EFF[Median efficiency]
  EFF --> PE[Planning efficiency = max of it and 0.85]
  AGE[Age] --> CAP[Time-in-bed cap: 12 / 11 / 10 / 9 h]
  NEED --> FULL[Full time in bed = min of cap and need ÷ planning efficiency]
  PE --> FULL
  CAP --> FULL
  FULL --> BED[Bedtime = wake − share × full time in bed]
  WAKE --> BED
  BED --> OUT[100 %, 85 %, 70 %]
```

## Formula

1. **Need tonight**, in minutes:

   need = baseline + max(0, strain + debt − nap), where:
   - **baseline** = `personalizedNeedHours` × 60: the median of the last 28 nights' sleep, floored at the lower bound of your age's guideline range (7 h asleep for adults, 8 h for 13–17, 9 h to 12, sliding between them by exact age since version 42) and capped at 9.5 h; 7.5 h before 7 nights (scoring version 15; it was the upper quartile with an 8 h floor; see [sleep-need](sleep-need.md)).
   - **strain** = min(30, 0.05 h × 60 × `strainPointsAbove(todayLoad, typicalSession)`): 3 minutes per Day Strain point that today's load (TRIMP so far) goes above your **typical training session** (`typicalSession`, the median of the training days in the 28 days before today, as Strain Target uses). Both are converted to the 0–21 scale through `trimpToStrain` and `toStrainScale`. A rest day, a routine session or a day not yet past your session adds 0; a light day never lowers the need. *Before scoring version 12* it compared with the 28-day **average** Strain, rest days included (see § Why the strain term changed).
   - **debt** = 0.2 × this morning's sleep debt in minutes (`ledger(...).magnitudeMin`). Since version 25 a night spent awake counts as 0 h in that debt ([sleep-need](sleep-need.md) § A night spent awake), so the evening after an all-nighter plans more sleep. Since version 40 the ledger carries 60 % of what is owed and adds each night's whole shortfall (beyond a 30-minute tolerance) ([sleep-need](sleep-need.md) § Why version 40), so debts read larger and fade more slowly. Sleeping the 100 % plan repays the 20 % on top of the 60 % carry: the next debt is 0.6 × debt − 0.2 × debt = 0.4 × this one. A 105-minute debt goes 105 → 42 → 17 → 7 (under the 10-minute band), about **3 nights**; sleeping exactly your baseline need clears it at 0.6 a night, in about 5. The time-in-bed cap still applies (in the 8 → 7 h simulation it never bound).
   - **nap** = today's minutes asleep in naps (`napAsleepMin`). Since version 42 it offsets only the strain and debt terms, never the baseline: `parts.napMin` = min(nap, strain + debt), the minutes it actually took off. Before, it came off minute for minute, down to 0 (§ Why version 42).
2. **Typical wake time** (*version 41*). Over the last 14 main sleeps:
   - keep the nights whose wake day is the same kind as tomorrow: weekday (Monday to Friday) or weekend (Saturday and Sunday); if none is, all 14;
   - of those, keep the ones whose wake time is within **2 h** (on the 24 h clock) of **last night's**, if at least 2 are; else within 2 h of the latest night of tomorrow's kind, if at least 2 are; else all of them;
   - take their **circular median** (`circularMedianMin`): the times are cut at the point opposite their circular mean and unrolled from there, so 23:40 and 00:20 give 00:00. Times that don't straddle that point, such as anyone waking in the morning, give exactly the plain median. Times spread right round the clock (resultant under 0.2) keep the plain median.
   - `wakeNights` says how many nights it came from.
   Before version 41 it was the plain median of tomorrow's kind of nights.
3. **Efficiency** = the median of the same nights' efficiency (asleep ÷ in bed). With none, use 0.9.
   - *Since version 24* bedtimes use the **planning efficiency** = max(efficiency, 0.85)
     (`minPlanningEfficiency`). `efficiencyFloored` is true when the median was under 0.85.
4. **Time-in-bed cap** by whole years of age (*since version 24*, `inBedCapHours`): **12 h** under 14, **11 h** for
   14–25, **10 h** for 26–64, **9 h** from 65, and 10 h when the age is unknown.
5. **Bedtimes** for share X ∈ {1, 0.85, 0.7}:
   - full time in bed = min(cap, need ÷ planning efficiency), and `capped` is true when the cap was the smaller;
   - time in bed = X × full time in bed, and bedtime = wake − time in bed;
   - `sleepMin` = X × need, or, when capped, time in bed × planning efficiency (less than X × need).

   Uncapped, this is exactly X × need ÷ planning efficiency, the version 23 formula whenever efficiency is 0.85 or
   more. Capped, the tiers are shares of the cap, so the three bedtimes stay apart (Peak is at the cap).

`bedtimeMin` is minutes from the wake day's local midnight, so −90 is 22:30 the evening before. `(bedtimeMin + 1440) % 1440` gives the clock time. Keeping the sign means the three bedtimes always sort earliest first, even across midnight.

## Inputs

| Input | Unit | Notes |
|---|---|---|
| `baselineNeedHours` | hours | `personalizedNeedHours(nightlyHours, ageYears)` (held, version 40), the same need the debt ledger used. The pipeline passes the exact age, `d.age.years` (version 42). |
| `todayLoad` | TRIMP, or null | Today's load so far (`strain.trimp`; 0 when worn with too little heart rate). null skips the strain term. |
| `typicalSession` | TRIMP, or null | `typicalSession` over the 28 days before today. null skips the strain term. |
| `debtMin` | minutes | This morning's debt magnitude. |
| `napMin` | minutes | Asleep minutes in today's non-main sessions. Offsets only the strain and debt terms (version 42). |
| `nights` | `{ day, wakeMin, efficiency }[]`, oldest first | Recent main sleeps. `day` is the wake day, `yyyy-MM-dd`. `wakeMin` is the **local** wake time in minutes after midnight; U10 converts from unix seconds in the user's time zone. The last 14 are used. |
| `wakeDay` | `yyyy-MM-dd` | Tomorrow, the morning being planned for. |
| `age` | whole years, or null | Sets the time-in-bed cap (*version 24*). The pipeline passes `d.age.whole`. |

## Outputs

`{ needMin, parts, wakeMin, wakeNights, weekend, efficiency, planningEfficiency, efficiencyFloored, inBedCapMin, capped, plans }`. `wakeMin` is 0–1439.
`parts` is `{ baselineMin, strainMin, debtMin, napMin, napAsleepMin }`: needMin = baselineMin + strainMin + debtMin −
napMin, where napMin is the nap minutes taken off and napAsleepMin the minutes napped (version 42).
Each plan is `{ share, sleepMin, inBedMin, bedtimeMin }`. Since version 38 the Recovery forecast reads none of it.

**On screen** (`planVM`, `src/server/queries/common.ts`):
- each goal's caption is the share of need it delivers, `round(sleepMin ÷ needMin × 100)` %: its share uncapped, less
  when capped;
- when `efficiencyFloored`: "You've been awake in bed for a good part of recent nights. These bedtimes plan for 85% of
  your time in bed asleep. Going to bed earlier usually adds time awake, not sleep.";
- when `capped`: "Time in bed is capped at {cap} h for your age.";
- when a nap was longer than the extras (`napAsleepMin > napMin`, version 42): "Today's {1 h 50 min} nap covers your
  extra need, not your night's sleep."


## Constants

All of these live in `sleepPlannerConfig`.

| Constant | Value | Kind |
|---|---|---|
| `hoursPerStrainPoint` | 0.05 h per Day Strain point above your typical session | *tunable* (spec); no published source |
| `maxStrainMin` | 30 | Pulse v12: bounds an extreme day |
| `debtRepayShare` | 0.2 | *tunable* (spec) |
| `windowNights` | 14 | spec |
| `similarWakeMin` / `minSimilarNights` | 120 min / 2 | version 41; *tunable* (90 and 180 min measured the same; 3 nights left the rotation's weekends on the other schedule) |
| `defaultEfficiency` | 0.9 | *tunable*: a typical healthy-adult efficiency, used only before any night has one |
| `shares` | 1, 0.85, 0.7 | spec |
| `minPlanningEfficiency` | 0.85 | version 24; cited: the ≥ 85 % efficiency target of CBT-I sleep restriction (Edinger 2021) |
| `inBedCapHours` | 12 h under 14, 11 h for 14–25, 10 h for 26–64, 9 h from 65 | version 24; cited: the upper "may be appropriate" sleep duration (NSF, Hirshkowitz 2015) |
| `unknownAgeCapHours` | 10 | version 24: the adult value |

## Edge rules

- **No nights** give `wakeMin: null` and no plans. The need is still returned.
- **A big nap** brings the need down to the baseline and no further (version 42; before, it could reach 0, which put
  every bedtime at the wake time).
- **One glitchy night** (efficiency 0.05 while it is the only night) used to give 150 h in bed. It is now planned at
  0.85: 8.8 h for a 7.5 h need (a test).
- **The cap is on time in bed, not on need.** A large debt still raises `needMin` (and the forecast); the cap only
  stops the bedtime moving earlier.
- **The median of an even count** is the mean of the middle two, so a wake time can fall on a half minute.

## Worked examples

1. **The base case** (a test). Need 8 h, no debt, today's load equal to your typical session, no nap: need = **480 min**. Tomorrow is a weekday, with a typical wake of 07:00 and efficiency 0.9. The 100 % bedtime is 07:00 − 480 / 0.9 = 07:00 − 533.3 min = **22:07** the evening before.
2. **A heavier day.** Need 8 h, 60 min of debt (+12), Day Strain 16 against a typical session of 10 (+6 × 0.05 h = +18 min), and a 20 min nap (−20): need = **490 min**. With a weekday wake of 07:00 and efficiency 0.9:

   | Share | Asleep | In bed | Bedtime |
   |---|---|---|---|
   | 100 % | 490 min | 544.4 min | **21:56** |
   | 85 % | 416.5 min | 462.8 min | **23:17** |
   | 70 % | 343 min | 381.1 min | **00:39** |

3. **A weekend morning** (a test). With weekend wakes at 09:00 and weekday wakes at 07:00, the same need gives bedtimes exactly 2 h later on a Friday night than on a Wednesday.

## Why version 42: a nap took tonight's need below the baseline

**The problem.** The need was baseline + strain + debt − nap, floored only at 0, so every nap minute came off the
night. The owner napped 1 h 50 min on 2026-10-11 and the Tonight card asked for **5 h 40 min** of a 7.5 h need: at a 07:00 wake
and 90 % efficiency, a 100 % bedtime of 00:42. Three reasons that is wrong:
- the nap is already counted: the debt ledger credits yesterday's naps to last night (`creditedSleepMin`), so taking it
  off tonight too counts it twice;
- a nap is mostly light sleep. It eases sleep pressure but doesn't replace the night's deep and REM sleep, or its timing
  on the body clock, and sleep guidance treats naps as a top-up, not a substitute;
- planning a short night after every nap teaches short nights.

**The change.** need = baseline + max(0, strain + debt − nap). A nap pays for the extra sleep a hard day or a debt
asks for, and nothing below your baseline (itself at least 7 h for adults). `parts.napMin` is the minutes it took off;
the new `parts.napAsleepMin` is the minutes napped, and the card says when the nap was longer than the extras.
Worked example 2 (a 20-minute nap against 30 minutes of extras) is unchanged.

**Measured.**
- The owner's day: 340 → **450 min** (the baseline); at a 07:00 wake and 90 % efficiency the 100 % bedtime moves from
  00:42 to 22:40.
- The seed: 21 of 174 plans have a nap; 19 now plan the baseline, the other 2 a nap the extras absorbed. Before, those
  nights planned as little as 380 of a 446-minute need (a week of 1-hour naps in August). No score moved: since
  version 38 nothing reads the plan.

The debt ledger is unchanged, so napping still lowers the next morning's debt, and with it the 20 % repayment.

## Why version 41: the typical wake time failed around midnight and for shift workers (audit S6)

**The problem.** A plain median of clock times treats the clock as a line, and the 14-night window mixes schedules.
- Wakes alternating 23:40 and 00:20 (1,420 and 20 minutes) gave a median of **12:00**, so the 100 % bedtime was 03:40,
  12 h off. An evening-shift sleeper waking at 00:10 ± 30 min was over 2 h off on 26 % of plans.
- A weekly day/night rotation (06:40 one week, 15:30 the next) always had 7 + 7 nights in the window, so the median
  fell between them: **265 min** off, over 2 h on every plan.

**The change:** the circular median, of nights like last night's, within tomorrow's kind of day (§ Formula, step 2).

**Why this order.** "Like last night" first, then the weekday/weekend split, got weekend lie-ins wrong: after a
Sunday 09:30 wake, Monday's plan drew on weekend nights (over 2 h off on 22.5 % of plans). The weekday/weekend split
first, anchored only on the latest night of tomorrow's kind, put a rotation's Saturday plan on the previous weekend's
schedule (28.6 % over 2 h). Anchoring on last night within tomorrow's kind, then on the latest night of that kind,
gets both right.

**How it was tested** (`sleepPlanner.sim.test.ts`). 40 people × 56 plans per pattern, each plan's wake time against the morning that followed, with v40's rule kept for comparison:

| Pattern | v40 median error / plans over 2 h off | v41 |
|---|---|---|
| Weekly rotation 06:40 ↔ 15:30 | 265 min / 100 % | **24 min / 14.4 %** (the first night after each switch) |
| Evening shift, 00:10 ± 30 | 45 min / 26 % | **21 min / 0.1 %** |
| Alternating 23:40 / 00:20 | 700 min / 100 % | **20 min / 0 %** |
| Weekday 07:00, weekend lie-in to 09:30 | 14 min / 0 % | 15 min / 0 % |
| Steady 07:00 | 18 min / 0 % | 18 min / 0 % |

**Still not handled:** a rotation that changes every night or two (2 early, 2 late). Tomorrow then differs from last
night half the time, which no rule based on recent nights can predict: 86 → 57 % of plans over 2 h off, but the median
error rises from 402 to 500 min. Fixing it would need the user's roster.

**On the seed** (174 plans): 7 wake times moved, by at most 17.5 min, where a night over 2 h from the others was left
out of the median; the other 167 are identical. **On the owner's data** the first plan (Oct 10, wake 08:45) is
unchanged.

## Why version 24: time in bed was unbounded

**The problem.** Time in bed was share × need ÷ your median efficiency, with no bound. Low efficiency and debt both
push the bedtime earlier, so the people who slept worst got the most extreme advice. For insomnia that is the
opposite of CBT-I (cognitive behavioural therapy for insomnia), which limits time awake in bed. It is the first-line
treatment (AASM guideline, Edinger 2021).

**How it was tested.** A copy of `sleepPlan` with switchable options; in "current" mode it matched the real function
on every night. The setup:
- 40 simulated people per profile, nights 30–59 of 60;
- a wake time of 07:00 ± 20 min;
- need and debt from the real `personalizedNeedHours` and `ledger`;
- each person's own mean sleep (± 0.3 h) and efficiency (± 0.03), with nightly noise.

Durations and efficiencies are assumptions that fit each picture.

| Profile (age) | Version 23: in bed, mean / max | Version 23 bedtime: median / earliest | Version 24: in bed, mean / max | Version 24 bedtime | Need reached at own efficiency |
|---|---|---|---|---|---|
| Healthy, 7.5 h at 90 % (35) | 8.3 / 9.5 h | 22:43 / 21:22 | unchanged | unchanged | 100 % |
| Insomnia, 6 h at 70 % (45) | 10.4 / 11.6 h | 20:36 / 19:20 | **8.5 / 9.0 h** | 22:30 / 21:41 | 82 % |
| Severe insomnia, 5 h at 60 % (50) | 12.6 / 14.9 h | 18:26 / 16:08 | **8.8 / 9.5 h** | 22:12 / 21:35 | 70 % |
| New parent, 5 h at 72 % (32) | 10.5 / 12.4 h | 20:33 / 18:41 | **8.8 / 9.4 h** | 22:11 / 21:28 | 84 % |
| Teen, 6.5 h at 80 % (16) | 12.0 / 13.8 h | 19:04 / 17:03 | **11.0 / 11.0 h** | 20:01 / 19:27 | 92 % |
| Teen, 8.8 h at 90 % (16) | 10.2 / 11.2 h | 20:46 / 19:33 | 10.2 / 11.0 h | 20:46 / 19:48 | 100 % |
| Older, 6.5 h at 78 % (72) | 9.1 / 10.5 h | 21:51 / 20:33 | 8.4 / 9.0 h | 22:36 / 21:48 | 92 % |
| Long sleeper, 9.3 h at 90 % (22) | 10.3 / 11.5 h | 20:37 / 19:13 | 10.3 / 11.0 h (capped 5 % of nights) | 20:37 / 19:35 | 100 % |
| Long sleeper, 9.3 h at 90 % (40) | 10.3 / 11.4 h | 20:44 / 19:20 | 9.9 / 10.0 h (capped 74 %) | 21:03 / 20:23 | 98 % |
| 8 h sleeper at 85 % (70) | 9.4 / 10.6 h | 21:32 / 20:05 | 8.9 / 9.0 h (capped 84 %) | 22:01 / 21:30 | 95 % |

Extreme inputs, 07:00 wake:

| Case | Version 23 | Version 24 |
|---|---|---|
| Need 9.5 h, 300 min debt, maximum strain, 60 % efficiency, age 30 | 18.3 h in bed, bedtime 12:40 | 10 h, 21:00 |
| One night at 5 % efficiency (the only night) | 150 h | 8.8 h, 22:11 |
| After an all-nighter (debt 513 min), 90 %, age 30 | 10.2 h, 20:46 | 10 h, 21:00 |

**"Need reached at own efficiency"** is the median share of need the Peak plan would deliver if you slept at your own
efficiency. Below 100 % is the point: for someone at 60–70 % efficiency, the plan stops promising the full need
through more time in bed. "Need tonight" still shows the full need.

**Options tested:**

| Option | Result | Chosen? |
|---|---|---|
| Efficiency floor 0.85 alone | Fixes insomnia, new parents and the glitch night. The extreme case still gives 12.9 h (18:08), and teens 11.3 h. | Part of it |
| Floor 0.80 instead | 0.5 h more in bed for insomnia (9.0 h), 0.6 h for new parents | No: CBT-I aims for ≥ 85 % |
| Floor + a flat 10 h cap (11 h under 18) | Caps a healthy 22-year-old 9.3 h sleeper on 81 % of nights (96 % of need) | No |
| Floor + an 11 h backstop for all | The extreme case still gives 11 h (about 20:00) | No |
| **Floor 0.85 + the NSF age cap** | As in the tables | **Yes** (user's choice) |
| Cap the debt term at 60 min | No change in any realistic profile, and it would move `needMin` and the forecast | No |

**Trade-offs:**
- The age cap binds for healthy long sleepers past its age band: a 40-year-old 9.3 h sleeper reaches 98 % of need,
  a 70-year-old 8 h sleeper 95 %. Both sit at the top of the NSF range for their age, so spending even longer in bed
  isn't advised for them.
- About 5 % of a "healthy" group's nights change: those people sleep at about 84 % efficiency, just under the floor.
- **Teens still get early bedtimes.** A 16-year-old who sleeps 6.5 h has the 9 h need floor, so even capped at 11 h
  the bedtime is about 20:00 at a 07:00 wake. That comes from the sleep need floor (see [sleep-need](sleep-need.md)),
  not from this planner, and is left open.
- **On the seed nothing moves.** The seed's efficiency is 0.92–0.96, so no day is floored or capped. Only the new
  fields change, and Golden 24 records them.

## Why the strain term changed (scoring version 12)

Tested on the real function, five trainer types and the 180-day demo database:

| Before (vs the 28-day average day) | After (vs your typical session) |
|---|---|
| A moderate trainer's **routine** session added +8 min; a daily trainer's identical session added 0 (no rest days in their average) | A routine session adds 0 for everyone; 1.5× / 2× / 3× your session add about 3 / 5 / 8 min for every trainer type |
| Extra sleep on 83 of 174 seed days (p90 12.4, max 15.3 min) | 38 of 174 days (p90 1.8, max 5.5 min): only the days that really were harder |
| A plan made in the morning counted the morning's tiny load against the average | Load below your usual session counts as 0, so the plan only grows once today passes your usual session |

The 3 minutes per point is kept from before; there is no published rate, and the demo data cannot calibrate it.

## Sources

- Hirshkowitz M, et al. National Sleep Foundation's sleep time duration recommendations: methodology and results
  summary. *Sleep Health* 2015;1:40–43. The "may be appropriate" upper bounds behind `inBedCapHours`.
- Edinger JD, et al. Behavioral and psychological treatments for chronic insomnia disorder in adults: an American
  Academy of Sleep Medicine clinical practice guideline. *J Clin Sleep Med* 2021;17(2):255–262. CBT-I and sleep
  restriction, which aims for ≥ 85 % efficiency (`minPlanningEfficiency`).
- noop (`ryanbr/noop`), `AnalyticsEngine.kt` `RestScorer` (sleep need) and `SleepDebt.kt` (14-night ledger), ported in `src/core/scoring/sleep.ts`.
- The reference app Sleep Planner: the design target (Peak, Perform and Get By, at 100 %, 85 % and 70 %); no the reference app coefficients are used.
