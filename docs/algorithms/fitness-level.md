# Fitness level: VO2max percentile

Code: `src/core/algorithms/fitnessLevel.ts`. Tests: `fitnessLevel.test.ts`.

Fitness level places a VO2max value among people of the same sex and age (since scoring version 49 the exact age, not the decade), using the FRIEND registry's measured treadmill VO2max. The percentile maps to one of five categories. The same table supplies the median (50th-percentile) VO2max that Healthspan scores against (the 75th before scoring version 19).

## Formula

1. **Build the row for the exact age** (`friendRowAt`, *since scoring version 49*). Each published row is placed at its decade's midpoint (25, 35 … 75).
   - **Between midpoints** each column is linear, the same as `vo2maxAtPercentile` and Healthspan's reference. So a 30-year-old's row is halfway between the 20s' and the 30s'.
   - **Under 25** it is the 20–29 row.
   - **Past 75** it is the 75-year row scaled by `referenceVo2max(age) / referenceVo2max(75)`. The median stays on Healthspan's extended reference (floored at 15), and the columns keep their order.
   - *Before version 49* the row was the decade's own (`floor(age / 10)`): ages 80+ used 70–79, and a decade birthday moved the percentile 18–30 points (§ Why version 49).
2. **Interpolate the percentile** linearly between the published columns (5, 10, 25, 50, 75, 90, 95). Below the 5th column it is 5, and above the 95th it is 95. The table does not resolve the tails, so the clamp keeps the number honest.
3. **Category by percentile:**

   | Category | Percentile |
   |---|---|
   | Poor | < 20 |
   | Fair | 20–39 |
   | Good | 40–59 |
   | Excellent | 60–79 |
   | Superior | ≥ 80 |

   The bands are half-open, so 39.9 is Fair and 40 is Good.
4. **The Healthspan reference**, `referenceVo2max(age, sex)`, is the 50th-percentile column (since scoring version 19; it was the 75th, see `healthspan.md`), linear between decade midpoints (25, 35 … 75), flat below 25, and past 75 continued with the 65 → 75 slope down to a floor of 15 mL/kg/min (`vo2maxAtPercentileExtended`; FRIEND has no row above 70–79). A decade step would make Pulse Age jump by about 1.5 years on a decade birthday. Since version 49 Fitness level reads the same curve, so someone exactly at the Healthspan reference is at the 50th percentile at every age.

## Why version 49: by exact age, not decade

**The problem.** The percentile used the decade's row. Within a decade it never changed with age; on the birthday the
row stepped down, so the same VO2max ranked much higher. With VO2max unchanged, the largest jump on each decade
birthday:

| Turning | Men | Women |
|---|---|---|
| 30 | +20.8 | **+30.3** (36.1: p45 Good → p75 Excellent) |
| 40 | +17.7 | +17.9 |
| 50 | +22.0 | +21.1 |
| 60 | +20.0 | +24.3 |
| 70 | +21.1 | +19.7 |

- **It disagreed with Healthspan.** Healthspan's reference already ran between decade midpoints (version 19), so
  someone exactly at it read the 37th to the 66th percentile depending on age. On the birthday they often moved a
  category or two (a woman turning 30: Fair → Excellent).
- **Past 79** the 70–79 row was used as-is: a man of 85 at the reference (20.6) read p26 "Fair", and at 95 (16.8)
  p8 "Poor".
- This doc already said "18–29 points" before the fix; the audit's "a few points" quoted an older version.

**The fix.** The row for the exact age is built as above.
- **Past 75 the row is scaled, not extended column by column.** Each column continued with its own slope to the 15
  floor collapses the row: a woman's 25th–95th columns all reach 15 by about 84, so 16 would read p95.

**Results** (`fitnessLevel.test.ts`):
- The largest change in percentile between consecutive hundredths of a year is under 0.15 points, at every age from
  14 to 100, for VO2max 10–75. Version 48: up to 30.3.
- The published row applies exactly at each midpoint (25, 35 … 75), so example 1 is unchanged.
- Healthspan's reference reads the 50th percentile at every age from 13 to 100, both sexes. A man of 85 at 20.6
  reads p50 "Good" (version 48: p26 "Fair"); at 95, p50 (p8 "Poor").
- Past 75 the row stays strictly increasing and is continuous at 75. A woman of 85 at 16 reads p44.

**On the demo database** (a man of 36, VO2max 42.9–45.1): the percentile rises by 2.0–2.8 points (his row is about 13–18 %
of the way to the 40s'), and 46 of 179 days move from Good to Excellent, where his VO2max sits at the 60th
percentile. Nothing else moved (golden test). The same days with a birthday set so he turns 40 mid-way: the largest
day-to-day change at the same VO2max is under 1 point (version 48: 14.8).

**On the owner's data** (local copies): no VO2max has been recorded yet, so there is no fitness level in either
version.

## Inputs

| Input | Unit | Notes |
|---|---|---|
| `vo2max` | mL O₂·kg⁻¹·min⁻¹ | `scoreFitness` (`src/server/pipeline/scores.ts`) picks the latest `run-vo2-max` within 90 days, otherwise the latest `daily-vo2-max` of any age. This is its own rule: since scoring version 19 Healthspan blends run and daily values over 6 months instead (`healthspan.md`). |
| `age` | years | Fractional is fine. |
| `sex` | `"male"` or `"female"` | FRIEND publishes only these two. |

FRIEND is **measured** VO2max from treadmill CPX tests, with RER ≥ 1.0. Fitbit's values are estimates, from runs or from resting HR, so the percentile is an estimate against a lab standard.

## Table

This is Kaminsky et al. 2015, Table 2, "Men/Women from FRIEND": 7,783 maximal treadmill tests, 2014–2015, eight US labs, adults without cardiovascular disease. The code holds the full 14 rows × 7 columns, men and women, ages 20–79, in `FRIEND_TREADMILL`.

| Men | 5th | 10th | 25th | 50th | 75th | 90th | 95th |
|---|---|---|---|---|---|---|---|
| 20–29 | 29.0 | 32.1 | 40.1 | 48.0 | 55.2 | 61.8 | 66.3 |
| 30–39 | 27.2 | 30.2 | 35.9 | 42.4 | 49.2 | 56.5 | 59.8 |
| 40–49 | 24.2 | 26.8 | 31.9 | 37.8 | 45.0 | 52.1 | 55.6 |
| 50–59 | 20.9 | 22.8 | 27.1 | 32.6 | 39.7 | 45.6 | 50.7 |
| 60–69 | 17.4 | 19.8 | 23.7 | 28.2 | 34.5 | 40.3 | 43.0 |
| 70–79 | 16.3 | 17.1 | 20.4 | 24.4 | 30.4 | 36.6 | 39.7 |

| Women | 5th | 10th | 25th | 50th | 75th | 90th | 95th |
|---|---|---|---|---|---|---|---|
| 20–29 | 21.7 | 23.9 | 30.5 | 37.6 | 44.7 | 51.3 | 56.0 |
| 30–39 | 19.0 | 20.9 | 25.3 | 30.2 | 36.1 | 41.4 | 45.8 |
| 40–49 | 17.0 | 18.8 | 22.1 | 26.7 | 32.4 | 38.4 | 41.7 |
| 50–59 | 16.0 | 17.3 | 19.9 | 23.4 | 27.6 | 32.0 | 35.9 |
| 60–69 | 13.4 | 14.6 | 17.2 | 20.0 | 23.8 | 27.0 | 29.4 |
| 70–79 | 13.1 | 13.6 | 15.6 | 18.3 | 20.8 | 23.1 | 24.1 |

**The 2022 update** (Kaminsky et al. 2022) adds 80–89 and more labs, with 16,278 treadmill tests from 1968 to 2021. Its full text was not reachable while this was written: the publisher returned 403, and the paper is not in PubMed Central. Its abstract reports that the updated treadmill standards are 1.5–4.6 mL·kg⁻¹·min⁻¹ lower than the 2015 ones. Because of that, a given VO2max scores a little lower against the 2015 table than it would against the 2022 table. To switch, replace the `FRIEND_TREADMILL` rows and add an 80–89 row.

## Constants

| Constant | Value | Kind |
|---|---|---|
| `FRIEND_TREADMILL`, `FRIEND_PERCENTILES` | Table 2 | cited: Kaminsky 2015 |
| `fitnessLevelConfig.categoryFloors` | 20 / 40 / 60 / 80 | *tunable* (spec) |
| `fitnessLevelConfig.referencePercentile` | 50 | *tunable* (spec); must be one of the table's columns |

## Worked examples

1. **A man of 35 with VO2max 45.** The 30–39 row has 42.4 at the 50th and 49.2 at the 75th, so the percentile is 50 + 25 × (45 − 42.4) / (49.2 − 42.4) = **59.6**, which is Good.
2. **A woman of 52 with VO2max 30.** Her row is 70 % of the way from the 40s' row (at 45) to the 50s' (at 55): 29.04 at the 75th and 33.92 at the 90th. So the percentile is 75 + 15 × 0.96 / 4.88 = **78.0**, which is Excellent. Version 48 used the 50–59 row as-is (27.6 and 32.0): 83.2, Superior.
3. **A woman of 45 with VO2max 16.** This is below the 5th column (17.0), so the percentile is **5** (clamped), which is Poor.
4. **The Healthspan reference for a man of 38** is 42.4 + (37.8 − 42.4) × 3 / 10 = **41.0**. At exactly 35 it is 42.4. For a woman of 85 it is 18.3 + (18.3 − 20.0) × 10 / 10 = **16.6**, and her row is the 75-year row × 16.6 / 18.3, so 16.6 is her 50th percentile.
5. **A woman turning 30 with VO2max 36.1:** p58.4 the day before and p58.5 on the day, Good both times. Version 48: p44.7 Good → p75.0 Excellent.

## Sources

- Kaminsky LA, Arena R, Myers J. Reference standards for cardiorespiratory fitness measured with cardiopulmonary exercise testing: data from the Fitness Registry and the Importance of Exercise National Database. *Mayo Clin Proc* 2015;90(11):1515–1523. doi:10.1016/j.mayocp.2015.07.026. Table 2. Free full text: PMC4919021.
- Kaminsky LA, Arena R, Myers J, et al. Updated reference standards for cardiorespiratory fitness measured with cardiopulmonary exercise testing: data from the Fitness Registry and the Importance of Exercise National Database (FRIEND). *Mayo Clin Proc* 2022;97(2):285–293. doi:10.1016/j.mayocp.2021.08.020. Abstract only; not used for values.
