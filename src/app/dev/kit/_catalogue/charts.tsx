import * as fx from "@/components/__fixtures__/kit"
import { EnergyBankChart } from "@/components/charts/EnergyBankChart"
import { Hypnogram } from "@/components/charts/Hypnogram"
import { IntradayHrChart } from "@/components/charts/IntradayHrChart"
import { SleepHrChart } from "@/components/charts/SleepHrChart"
import { StrainRecoveryChart, StrainRecoveryChartSkeleton } from "@/components/charts/StrainRecoveryChart"
import { StressChart } from "@/components/charts/StressChart"
import { TrendChart } from "@/components/charts/TrendChart"
import { ZoneBars } from "@/components/charts/ZoneBars"
import { REASON_CODES } from "@/lib/reasons"
import type { KitEntry } from "./types"

/** One full-width frame with the chart in every reason state (each keeps the chart's height). */
const everyReason = (render: (r: (typeof REASON_CODES)[number]) => React.ReactNode) => ({
  name: "every reason code",
  full: true,
  node: (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {REASON_CODES.map((r) => (
        <div key={r}>{render(r)}</div>
      ))}
    </div>
  ),
})

export const CHARTS: KitEntry[] = [
  {
    id: "trend-chart",
    name: "TrendChart",
    file: "src/components/charts/TrendChart.tsx",
    use: "Every detail screen's trend card, Trends, Fitness and the vital sheets: W, M, 6M bars or a 6M line.",
    props: ["label, data: Metric<TrendPoint[]>", "unit, format", "colorBy: band | strain | sleep | single | stress", "direction, deltas", "baseline, target, reference", "fixedRange, defaultRange, ranges"],
    states: [
      {
        name: "recovery by band, normal range shaded, provisional days",
        full: true,
        node: <TrendChart label="Recovery" data={fx.ok(fx.recoveryTrend)} unit="%" format="int" colorBy="band" direction="up" deltas={{ w: 4, m: -3, "6m": 2 }} baseline={{ mean: 62, sd: 12 }} />,
      },
      { name: "strain with the Strain Target", node: <TrendChart label="Strain" data={fx.ok(fx.strainTrend)} format="decimal1" colorBy="strain" target={[12, 15]} deltas={{ m: 0.8 }} /> },
      { name: "sleep debt, gaps", node: <TrendChart label="Sleep debt" data={fx.ok(fx.sleepDebtTrend)} unit="h" format="decimal1" colorBy="sleep" direction="down" deltas={{ m: -0.4 }} /> },
      { name: "stress, fixed 30-day range", node: <TrendChart label="Stress" data={fx.ok(fx.stressTrend)} format="decimal1" colorBy="stress" fixedRange="m" /> },
      { name: "6M line with a reference", node: <TrendChart label="Pulse Age" data={fx.ok(fx.recoveryTrend)} format="int" colorBy="single" fixedRange="6m" reference={{ y: 50, label: "Your age" }} /> },
      { name: "empty (no scored days)", node: <TrendChart label="Recovery" data={fx.ok(fx.emptyTrend)} unit="%" format="int" colorBy="band" /> },
      { name: "loading", node: <TrendChart label="Recovery" data={undefined} format="int" colorBy="band" /> },
      everyReason((r) => <TrendChart label="Recovery" data={fx.why(r, 4)} format="int" colorBy="band" />),
      { name: "at 320 px", narrow: true, node: <TrendChart label="Recovery" data={fx.ok(fx.recoveryTrend)} unit="%" format="int" colorBy="band" direction="up" deltas={{ m: -3 }} /> },
    ],
  },
  {
    id: "hypnogram",
    name: "Hypnogram",
    file: "src/components/charts/Hypnogram.tsx",
    use: "The four-lane stage chart for a night (Sleep).",
    props: ["data: Metric<HypnogramNight> | null"],
    states: [
      { name: "a night", full: true, node: <Hypnogram data={fx.ok(fx.night)} /> },
      { name: "no stage data (no segments)", node: <Hypnogram data={fx.ok({ ...fx.night, segments: [] })} /> },
      { name: "loading", node: <Hypnogram data={undefined} /> },
      everyReason((r) => <Hypnogram data={fx.why(r, 4)} />),
      { name: "at 320 px", narrow: true, node: <Hypnogram data={fx.ok(fx.night)} /> },
    ],
  },
  {
    id: "intraday-hr-chart",
    name: "IntradayHrChart",
    file: "src/components/charts/IntradayHrChart.tsx",
    use: "Strain's day heart rate with sleep and workout spans, and an activity's heart rate by zone.",
    props: ["data: Metric<HrSeries>", "variant: day | activity"],
    states: [
      { name: "day: spans, a band-off gap, now", full: true, node: <IntradayHrChart data={fx.ok(fx.hrDay)} /> },
      { name: "activity", node: <IntradayHrChart variant="activity" data={fx.ok(fx.hrActivity)} /> },
      { name: "empty and loading", node: <div className="space-y-3"><IntradayHrChart data={fx.ok({ points: [] })} /><IntradayHrChart data={undefined} /></div> },
      everyReason((r) => <IntradayHrChart data={fx.why(r, 4)} />),
      { name: "at 320 px", narrow: true, node: <IntradayHrChart data={fx.ok(fx.hrDay)} /> },
    ],
  },
  {
    id: "sleep-hr-chart",
    name: "SleepHrChart",
    file: "src/components/charts/SleepHrChart.tsx",
    use: "Overnight heart rate inside SleepStages; the chosen stage is drawn bright.",
    props: ["data: Metric<SleepHr> | null", "highlight: { start, end }[]"],
    states: [
      { name: "the whole night lit, a gap", node: <SleepHrChart data={fx.ok(fx.sleepHr)} /> },
      { name: "deep sleep highlighted", node: <SleepHrChart data={fx.ok(fx.sleepHr)} highlight={fx.night.segments.filter((s) => s.stage === "deep")} /> },
      { name: "loading", node: <SleepHrChart data={undefined} /> },
      everyReason((r) => <SleepHrChart data={fx.why(r, 4)} />),
    ],
  },
  {
    id: "strain-recovery-chart",
    name: "StrainRecoveryChart",
    file: "src/components/charts/StrainRecoveryChart.tsx",
    use: "Home's “Strain & Recovery” week: strain bars on the left axis, recovery dots on the right.",
    props: ["points: { day, strain, recovery }[]", "today", "grow"],
    states: [
      { name: "a week with a missing strain and recovery", full: true, node: <StrainRecoveryChart points={fx.strainRecoveryWeek} today={fx.TODAY} /> },
      { name: "loading", node: <StrainRecoveryChartSkeleton /> },
      { name: "at 320 px", narrow: true, node: <StrainRecoveryChart points={fx.strainRecoveryWeek} today={fx.TODAY} /> },
    ],
  },
  {
    id: "stress-chart",
    name: "StressChart",
    file: "src/components/charts/StressChart.tsx",
    use: "Stress Monitor's day chart (full) and Home's Stress Monitor card (spark).",
    props: ["data: Metric<StressSeries>", "variant: full | spark"],
    states: [
      { name: "full", full: true, node: <StressChart variant="full" data={fx.ok(fx.stress)} /> },
      { name: "spark", node: <StressChart variant="spark" data={fx.ok(fx.stress)} /> },
      { name: "empty, full and spark", node: <div className="space-y-3"><StressChart variant="full" data={fx.ok({ points: [] })} /><StressChart variant="spark" data={fx.ok({ points: [] })} /></div> },
      { name: "loading, full and spark", node: <div className="space-y-3"><StressChart variant="full" data={undefined} /><StressChart variant="spark" data={undefined} /></div> },
      everyReason((r) => <StressChart variant="spark" data={fx.why(r, 4)} />),
    ],
  },
  {
    id: "energy-bank-chart",
    name: "EnergyBankChart",
    file: "src/components/charts/EnergyBankChart.tsx",
    use: "Home's Energy Bank card: energy left today with drains and naps.",
    props: ["data: Metric<EnergySeries> | null"],
    states: [
      { name: "a day with drains and a nap", node: <EnergyBankChart data={fx.ok(fx.energy)} /> },
      { name: "empty and loading", node: <div className="space-y-3"><EnergyBankChart data={null} /><EnergyBankChart data={undefined} /></div> },
      everyReason((r) => <EnergyBankChart data={fx.why(r, 4)} />),
    ],
  },
  {
    id: "zone-bars",
    name: "ZoneBars",
    file: "src/components/charts/ZoneBars.tsx",
    use: "Heart-rate zones on Strain and Activity (rows); Recovery and stress breakdowns in Reports and Stress (stacked).",
    props: ["variant: rows | stacked", "data", "rows: maxHr", "stacked: unit days | minutes", "emptyCopy"],
    states: [
      { name: "rows, an empty top zone", node: <ZoneBars variant="rows" data={fx.ok(fx.zones)} note="Zones on your heart-rate reserve: resting 56 to max 186 bpm." /> },
      {
        name: "stacked: days, minutes",
        node: (
          <div className="space-y-6">
            <ZoneBars variant="stacked" unit="days" data={fx.ok(fx.recoveryBreakdown)} />
            <ZoneBars variant="stacked" unit="minutes" data={fx.ok(fx.stressMinutes)} />
          </div>
        ),
      },
      {
        name: "empty and loading",
        node: (
          <div className="space-y-4">
            <ZoneBars variant="rows" data={null} />
            <ZoneBars variant="stacked" unit="days" data={fx.ok([])} />
            <ZoneBars variant="rows" data={undefined} />
            <ZoneBars variant="stacked" unit="days" data={undefined} />
          </div>
        ),
      },
      everyReason((r) => <ZoneBars variant="rows" data={fx.why(r, 4)} />),
      { name: "rows at 320 px", narrow: true, node: <ZoneBars variant="rows" data={fx.ok(fx.zones)} note="Zones on your heart-rate reserve: resting 56 to max 186 bpm." /> },
    ],
  },
]
