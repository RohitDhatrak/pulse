# Recovery: nights with missing inputs

Code: `src/core/scoring/recovery.ts` (`recovery()`, `missingInputScale`, `compositeSd`, `termSd`, `termCorr`) and
`src/server/pipeline/scores.ts` (`scoreRecovery`, the Energy Bank's `withoutSleep`). Tests: `recovery.test.ts`
("missing inputs"), `recovery.missing.sim.test.ts`, and "the Energy Bank counts last night's sleep once" in
`pipeline.test.ts`.

Recovery averages up to five terms, each a z-score against your normal: HRV (weight 0.55), resting HR (0.20), sleep
(0.15), breathing and skin temperature (0.05 each). A term is missing when the night has no value or its baseline isn't
usable yet:
- phone or Health Connect nights often have no breathing rate or skin temperature;
- the first nights after a new device, before the resting-HR, breathing or skin baselines are usable;
- a night the band missed part of.

HRV is never missing on a scored night: without it Recovery isn't scored at all.

## Formula (scoring version 37)

    z_avg = Σ (w_i × z_i) / Σ w_i                           over the terms present
    z     = z_avg × min(1, SD(full set) / SD(terms present))
    SD(set) = √(Σ_i Σ_j w_i w_j s_i s_j ρ_ij) / Σ w_i

- `s_i` (`termSd`): each term's spread on healthy nights: HRV 1, resting HR 1, breathing 0.6, sleep 0.4, skin 0.15.
- `ρ_ij` (`termCorr`): HRV–resting HR 0.35, HRV–sleep 0.2, resting HR–sleep 0.15, all other pairs 0.
- **The full set** is the five terms, minus any term the caller leaves out on purpose (`omit`). The Energy Bank's start
  passes `omit: ["sleep"]`, because it adds sleep performance itself (§ The Energy Bank).
- noop's two extra terms (`recoveryIndexSlope`, `priorDayEffort`, never passed by the pipeline) are averaged in as
  before but are not part of the scale.

**The factor for each set of terms present** (to 3 decimals):

| Terms present | Factor | Terms present | Factor |
|---|---|---|---|
| all five | 1 | HRV, resting HR, sleep | 0.901 |
| no skin temperature | 0.950 | HRV, sleep | 0.823 |
| no breathing | 0.951 | HRV, resting HR | 0.769 |
| no breathing or skin temperature | 0.901 | HRV only | 0.664 |

The factor is never above 1, and adding a term never lowers it (a test checks every subset).

## Why version 37

**The problem (audit item R5).** Averaging several partly independent signals cancels some of each one's nightly noise.
Drop terms and the average swings more, so on ordinary nights a fewer-input Recovery read red more often, though there
was less evidence, not more. On healthy simulated nights (60 people × 180 nights, nights 30 on, `recovery.missing.sim`):

| Terms present | Red / green, v36 | Red / green, v37 | Day-to-day swing, v36 → v37 |
|---|---|---|---|
| All five | 20 / 33 % | 20 / 33 % | 22.6 → 22.6 |
| No skin temperature | 21 / 34 % | 19 / 34 % | 23.3 → 22.5 |
| No breathing or skin | 22 / 35 % | 19 / 34 % | 24.2 → 22.6 |
| HRV + resting HR | 26 / 36 % | 19 / 34 % | 26.8 → 22.6 |
| HRV + sleep | 25 / 35 % | 19 / 33 % | 26.0 → 22.8 |
| HRV only | 30 / 37 % | 19 / 33 % | 29.5 → 22.9 |

The same holds within 2 points for older people (HRV 22 ms), heavy-tailed nights, a slow-moving recovery state (φ 0.8),
and people whose sleep and breathing are twice as noisy as `termSd` assumes.

**Why these constants.** They are each term's spread and correlations measured on the healthy simulation (HRV and
resting HR z about 1.05 since version 36; breathing 0.63, near its spread floor; sleep 0.42, its 0.12 scale against a
night-to-night SD of about 0.05; skin 0.15). A single shared correlation for all terms didn't work, because the terms'
spreads differ fivefold: it left HRV-and-sleep nights 3–4 points less red than full ones.

**The cost.** A fewer-input night is weaker evidence, so a real event reads a little milder on it. Share of red nights,
v36 → v37:

| Event | Every input | HRV + resting HR | HRV only |
|---|---|---|---|
| A 5-night illness (HRV −30 %, resting HR +7, breathing +1.5, skin +0.6 °C, sleep −8) | 97 → 97 % | 97 → 95 % | 92 → 86 % |
| A night after drinking (HRV −25 %, resting HR +5) | 88 → 88 % | 92 → 89 % | 83 → 75 % |

The illness signal, the illness hold, Readiness, the bands and the logistic are unchanged.

## The Energy Bank

The Energy Bank starts from Recovery's body signals only (`recovery.withoutSleep`), since it adds sleep performance
itself. That call passes `omit: ["sleep"]`, so a night with every body signal keeps factor 1, as before. A night missing a
body signal is scaled against the four body terms. Since version 37 `withoutSleep` is always recomputed that way; before,
a night without a sleep value reused the shown score.

## Drivers

`chargeDrivers` scores each counterfactual (one input set to its baseline) with the same terms present, so every
counterfactual uses the same factor, and the driver points still add up as before.

## On the data

- **The seed** (`GOLDEN[37]`, the parity snapshot): the 154 full-input nights are byte-identical. The 16 nights without
  skin temperature moved by 0.74 points on average (at most 1.4). The bands stay 52 / 93 / 25 green, yellow and red.
  Strain and sleep are unchanged.
- **The owner's data** (local copies): no night has a Recovery yet. The phone nights before Oct 4 have no HRV, so they
  are never scored, and Oct 4–10 are calibrating. All seven Fitbit nights carry HRV, resting HR, breathing and skin
  temperature, so the change is a no-op there for now.
