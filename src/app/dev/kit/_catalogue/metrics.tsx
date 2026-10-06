import { Activity, Droplet, Footprints, Heart, Moon, Rabbit, Thermometer, Timer, Turtle, Wind, Zap } from "lucide-react"
import * as fx from "@/components/__fixtures__/kit"
import { ActivityCard } from "@/components/metrics/ActivityCard"
import { AgeOrb } from "@/components/metrics/AgeOrb"
import { ConnectionBanner } from "@/components/metrics/ConnectionBanner"
import { ContributorRow } from "@/components/metrics/ContributorRow"
import { DayStrip, DayStripSkeleton } from "@/components/metrics/DayStrip"
import { DriverList } from "@/components/metrics/DriverList"
import { InsightCard } from "@/components/metrics/InsightCard"
import { KeyStatRow } from "@/components/metrics/KeyStatRow"
import { MiniRing } from "@/components/metrics/MiniRing"
import { DeltaMark, MetricTags, StatusChip, Tag, ValueUnit } from "@/components/metrics/primitives"
import { ReasonPlaceholder } from "@/components/metrics/ReasonPlaceholder"
import { ScoreDial, ScoreDialSkeleton } from "@/components/metrics/ScoreDial"
import { SleepCard } from "@/components/metrics/SleepCard"
import { SleepStages } from "@/components/metrics/SleepStages"
import { TickScale } from "@/components/metrics/TickScale"
import { ShellStatusProvider } from "@/components/shells/ShellStatus"
import { Card } from "@/components/ui/card"
import { REASON_CODES } from "@/lib/reasons"
import { HealthspanList, SelectableImpact, SelectableTile } from "../Islands"
import type { KitEntry } from "./types"

const STAT_ICON: Record<string, React.ReactNode> = {
  hrv: <Activity />,
  rhr: <Heart />,
  rr: <Wind />,
  sleep: <Moon />,
  cal: <Zap />,
  steps: <Footprints />,
  spo2: <Droplet />,
  temp: <Thermometer />,
  max: <Heart />,
  dur: <Timer />,
  hours: <Moon />,
  consistency: <Moon />,
  efficiency: <Moon />,
  restorative: <Moon />,
}

const ROWS = "divide-y divide-border rounded-xl bg-card px-4 py-1"
const row = "flex flex-wrap items-start justify-center gap-2"
const reasons = REASON_CODES.map((r) => ({ r, metric: fx.why<number>(r, 4) }))

export const METRICS: KitEntry[] = [
  {
    id: "score-dial",
    name: "ScoreDial",
    file: "src/components/metrics/ScoreDial.tsx",
    use: "Home's three rings (md), the Recovery, Strain, Sleep and Stress heroes (lg), sticky headers (compact), forecasts and reports (sm).",
    props: ["variant: recovery | strain | sleep | stat | gauge", "size: sm | md | lg", "value: number | null", "reason, nightsLeft", "provisional, tags, extraTags", "target: [lo, hi]", "status (sleep lg)", "compact", "loading", "href"],
    states: [
      {
        name: "md, Home row: links, Strain Target, So far",
        full: true,
        node: (
          <div className={row}>
            <ScoreDial variant="sleep" size="md" value={74} href="/sleep" />
            <ScoreDial variant="recovery" size="md" value={85} href="/recovery" />
            <ScoreDial variant="strain" size="md" value={9.4} target={[12, 15]} extraTags={["so_far"]} href="/strain" />
          </div>
        ),
      },
      {
        name: "md, Home row at 320 px",
        narrow: true,
        node: (
          <div className="flex items-start justify-center gap-1">
            <ScoreDial variant="sleep" size="md" value={100} href="/sleep" />
            <ScoreDial variant="recovery" size="md" value={100} href="/recovery" />
            <ScoreDial variant="strain" size="md" value={21} target={[12, 15]} extraTags={["so_far"]} href="/strain" />
          </div>
        ),
      },
      {
        name: "md, extremes: 0%, 7%, 0.0",
        node: (
          <div className={row}>
            <ScoreDial variant="sleep" size="md" value={0} />
            <ScoreDial variant="recovery" size="md" value={7} />
            <ScoreDial variant="strain" size="md" value={0} target={[12, 15]} />
          </div>
        ),
      },
      {
        name: "md, reasons (one ReasonPlaceholder line under the row)",
        node: (
          <div className="flex flex-col items-center gap-3">
            <div className={row}>
              <ScoreDial variant="sleep" size="md" value={null} reason="awaiting_sleep_sync" />
              <ScoreDial variant="recovery" size="md" value={null} reason="calibrating" nightsLeft={4} />
              <ScoreDial variant="strain" size="md" value={null} reason="band_not_worn" />
            </div>
            <ReasonPlaceholder reason="calibrating" nightsLeft={4} size="sm" />
          </div>
        ),
      },
      {
        name: "md, loading",
        node: (
          <div className={row}>
            <ScoreDialSkeleton size="md" />
            <ScoreDialSkeleton size="md" />
            <ScoreDialSkeleton size="md" />
          </div>
        ),
      },
      { name: "lg recovery, green, provisional", center: true, node: <ScoreDial variant="recovery" size="lg" value={85} provisional /> },
      { name: "lg recovery, yellow, baseline stale", center: true, node: <ScoreDial variant="recovery" size="lg" value={58} tags={["stale_baseline"]} /> },
      { name: "lg recovery, red, two tags (widest stack)", center: true, node: <ScoreDial variant="recovery" size="lg" value={8} provisional tags={["stale_baseline"]} /> },
      { name: "lg recovery, 100%", center: true, node: <ScoreDial variant="recovery" size="lg" value={100} /> },
      { name: "lg strain, target, So far", center: true, node: <ScoreDial variant="strain" size="lg" value={13.1} target={[12, 15]} extraTags={["so_far"]} /> },
      { name: "lg strain, 0.0 at the start of the day", center: true, node: <ScoreDial variant="strain" size="lg" value={0} target={[12, 15]} extraTags={["so_far"]} /> },
      { name: "lg strain, 21.0 past the target", center: true, node: <ScoreDial variant="strain" size="lg" value={21} target={[12, 15]} /> },
      { name: "lg strain, no target", center: true, node: <ScoreDial variant="strain" size="lg" value={4.2} /> },
      { name: "lg sleep, status bar and Updated (tallest stack)", center: true, node: <ScoreDial variant="sleep" size="lg" value={84} status="sufficient" tags={["updated"]} /> },
      { name: "lg sleep, 100%, optimal", center: true, node: <ScoreDial variant="sleep" size="lg" value={100} status="optimal" /> },
      { name: "lg sleep, 7%, poor, provisional", center: true, node: <ScoreDial variant="sleep" size="lg" value={7} status="poor" provisional /> },
      {
        name: "lg, every reason code",
        full: true,
        node: (
          <div className="grid justify-items-center gap-6 md:grid-cols-2 xl:grid-cols-3">
            {REASON_CODES.map((r) => (
              <ScoreDial key={r} variant={r === "awaiting_sleep_sync" ? "sleep" : r === "insufficient_hr_data" ? "strain" : "recovery"} size="lg" value={null} reason={r} nightsLeft={4} />
            ))}
          </div>
        ),
      },
      { name: "lg, loading", center: true, node: <ScoreDialSkeleton size="lg" variant="recovery" label="Recovery" /> },
      { name: "lg gauge (Stress)", center: true, node: <ScoreDial variant="gauge" size="lg" value={1.5} caption="Last updated 15:05" /> },
      { name: "lg gauge, reason", center: true, node: <ScoreDial variant="gauge" size="lg" value={null} reason="band_not_worn" /> },
      {
        name: "compact (sticky header): recovery, strain, sleep, gauge",
        node: (
          <div className="flex items-center justify-center gap-3">
            <ScoreDial variant="recovery" size="lg" value={85} compact />
            <ScoreDial variant="strain" size="lg" value={13.1} target={[12, 15]} compact />
            <ScoreDial variant="sleep" size="lg" value={100} compact />
            <ScoreDial variant="gauge" size="lg" value={2.4} compact />
          </div>
        ),
      },
      {
        name: "sm stat: forecast, average, reason, loading",
        node: (
          <div className="flex flex-wrap items-start justify-center gap-4">
            <ScoreDial variant="stat" size="sm" value={71} max={100} color="recovery-green" unit="%" label="Tomorrow" extraTags={["estimate"]} />
            <ScoreDial variant="stat" size="sm" value={100} max={100} color="recovery-green" unit="%" label="Best" />
            <ScoreDial variant="stat" size="sm" value={11.2} max={21} color="strain" format="decimal1" label="Avg strain" />
            <ScoreDial variant="stat" size="sm" value={null} reason="calibrating" label="Forecast" />
            <ScoreDialSkeleton size="sm" />
          </div>
        ),
      },
    ],
  },
  {
    id: "mini-ring",
    name: "MiniRing",
    file: "src/components/metrics/MiniRing.tsx",
    use: "The 22 px rings in Home's collapsed header.",
    props: ["variant: sleep | recovery | strain", "value: number | null", "fill (false draws the track only)"],
    cols: 3,
    states: [
      {
        name: "Values: 0, mid, max",
        node: (
          <div className="flex flex-wrap items-center justify-center gap-3">
            {(["sleep", "recovery", "strain"] as const).map((v) => [0, v === "strain" ? 10.5 : 50, v === "strain" ? 21 : 100].map((n) => <MiniRing key={`${v}${n}`} variant={v} value={n} />))}
          </div>
        ),
      },
      { name: "No value", center: true, node: <MiniRing variant="recovery" value={null} /> },
      { name: "Track only (before the reveal)", center: true, node: <MiniRing variant="recovery" value={72} fill={false} /> },
    ],
  },
  {
    id: "key-stat-row",
    name: "KeyStatRow",
    file: "src/components/metrics/KeyStatRow.tsx",
    use: "Home's key statistics and My Dashboard, the detail screens' summary cards, Health Monitor tiles.",
    props: ["variant: row | card | tile", "label, icon, caption", "metric: Metric<number>", "unit, format", "average, sd, direction", "status (sleep rows)", "chip (tiles)", "href | onSelect"],
    states: [
      {
        name: "row, vs. 30-day average",
        full: true,
        node: (
          <div className={ROWS}>
            {fx.keyStats.map(({ key, ...s }) => (
              <KeyStatRow key={key} variant="row" icon={STAT_ICON[key]} href="/recovery" {...s} />
            ))}
            <KeyStatRow variant="row" label="Strain Target" metric={fx.ok(12)} format="decimal1" direction="none" caption="Estimate" />
          </div>
        ),
      },
      {
        name: "row, sleep status segments",
        node: (
          <div className={ROWS}>
            {fx.sleepRows.map(({ key, ...s }) => (
              <KeyStatRow key={key} variant="row" icon={STAT_ICON[key]} unit="%" format="int" direction="none" {...s} />
            ))}
          </div>
        ),
      },
      {
        name: "row, every reason code",
        node: (
          <div className={ROWS}>
            {reasons.map(({ r, metric }) => (
              <KeyStatRow key={r} variant="row" label={r} metric={metric} unit="ms" format="int" direction="up" />
            ))}
          </div>
        ),
      },
      {
        name: "row, extremes and loading",
        node: (
          <div className={ROWS}>
            <KeyStatRow variant="row" label="Steps" metric={fx.ok(104382)} format="grouped" average={9020} sd={1800} direction="up" />
            <KeyStatRow variant="row" label="Skin temperature" metric={fx.ok(-2.4, { provisional: true })} unit="°C" format="signed1" average={0} sd={0.2} direction="toward_zero" />
            <KeyStatRow variant="row" label="Heart rate variability" metric={fx.ok(0)} unit="ms" format="int" average={98} sd={11} direction="up" />
            <KeyStatRow variant="row" label="Loading" metric={undefined} format="int" direction="up" />
          </div>
        ),
      },
      {
        name: "card (My Dashboard)",
        node: (
          <div className="space-y-2">
            <KeyStatRow variant="card" icon={STAT_ICON.hrv} label="Heart rate variability" metric={fx.ok(124)} unit="ms" format="int" average={98} sd={11} direction="up" href="/recovery" />
            <KeyStatRow variant="card" icon={STAT_ICON.spo2} label="Blood oxygen" metric={fx.why<number>("band_not_worn")} unit="%" format="int" average={97} direction="up" href="/health/monitor" />
          </div>
        ),
      },
      {
        name: "row at 320 px",
        narrow: true,
        node: (
          <div className={ROWS}>
            {fx.keyStats.slice(0, 4).map(({ key, ...s }) => (
              <KeyStatRow key={key} variant="row" icon={STAT_ICON[key]} {...s} />
            ))}
          </div>
        ),
      },
      {
        name: "tile: chips, out of range, reason, provisional, vs. average, loading, selectable",
        full: true,
        node: (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {fx.vitals.map(({ key, ...v }) => (
              <KeyStatRow key={key} variant="tile" icon={STAT_ICON[key]} direction="neutral" {...v} />
            ))}
            {fx.activityTiles.map(({ key, ...v }) => (
              <KeyStatRow key={key} variant="tile" icon={STAT_ICON[key]} {...v} />
            ))}
            <KeyStatRow variant="tile" label="Loading" metric={undefined} format="int" direction="up" />
            <SelectableTile />
          </div>
        ),
      },
    ],
  },
  {
    id: "contributor-row",
    name: "ContributorRow",
    file: "src/components/metrics/ContributorRow.tsx",
    use: "Recovery's contributors (value against your normal range) and Healthspan's contributors (years added or removed).",
    props: ["variant: recovery | healthspan", "label, icon, metric, unit, format", "recovery: baseline, points, direction", "healthspan: domain, target, years, higherIsBetter, onSelect"],
    states: [
      {
        name: "recovery, with the legend and a skeleton row",
        node: (
          <Card className="gap-0 px-4 py-1 ring-0">
            <div className="divide-y divide-border">
              {fx.contributors.map(({ key, ...c }) => (
                <ContributorRow key={key} variant="recovery" icon={STAT_ICON[key]} {...c} />
              ))}
              <ContributorRow.Skeleton />
            </div>
            <p className="my-3 rounded-lg bg-inset px-3 py-2 text-xs leading-4 font-medium text-foreground-secondary">Dot: today. Shaded: your normal range.</p>
          </Card>
        ),
      },
      {
        name: "healthspan, selectable (opens a sheet)",
        node: (
          <Card className="gap-0 px-4 py-1 ring-0">
            <HealthspanList />
          </Card>
        ),
      },
      {
        name: "recovery, every reason code and extremes",
        node: (
          <Card className="gap-0 px-4 py-1 ring-0">
            <div className="divide-y divide-border">
              {reasons.map(({ r, metric }) => (
                <ContributorRow key={r} variant="recovery" label={r} metric={metric} unit="ms" format="int" baseline={{ mean: 98, sd: 11 }} points={null} direction="up" />
              ))}
              <ContributorRow variant="recovery" label="Far above normal" metric={fx.ok(240)} unit="ms" format="int" baseline={{ mean: 98, sd: 11 }} points={24} direction="up" />
              <ContributorRow variant="recovery" label="Far below normal" metric={fx.ok(12)} unit="ms" format="int" baseline={{ mean: 98, sd: 11 }} points={-31} direction="up" />
            </div>
          </Card>
        ),
      },
      {
        name: "recovery at 320 px",
        narrow: true,
        node: (
          <Card className="gap-0 px-4 py-1 ring-0">
            <div className="divide-y divide-border">
              {fx.contributors.slice(0, 3).map(({ key, ...c }) => (
                <ContributorRow key={key} variant="recovery" icon={STAT_ICON[key]} {...c} />
              ))}
            </div>
          </Card>
        ),
      },
    ],
  },
  {
    id: "driver-list",
    name: "DriverList",
    file: "src/components/metrics/DriverList.tsx",
    use: "Recovery's “What shaped it” and Journal Insights' behaviour impacts.",
    props: ["variant: recovery | impact", "unit: pts | % | SD", "data: Metric<DriverItem[]>", "selectedKey, onSelect", "outcome"],
    states: [
      { name: "recovery", node: <DriverList variant="recovery" unit="pts" data={fx.recoveryDrivers} /> },
      { name: "impact, provisional, selectable", node: <SelectableImpact /> },
      { name: "empty (recovery)", node: <DriverList variant="recovery" unit="pts" data={null} /> },
      { name: "empty (impact): check in prompt", node: <DriverList variant="impact" unit="%" data={fx.ok([])} /> },
      {
        name: "every reason code",
        node: (
          <div className="space-y-4">
            {REASON_CODES.map((r) => (
              <DriverList key={r} variant="recovery" unit="pts" data={fx.why(r, 4)} />
            ))}
          </div>
        ),
      },
      { name: "loading", node: <DriverList variant="recovery" unit="pts" data={undefined} /> },
      { name: "recovery at 320 px", narrow: true, node: <DriverList variant="recovery" unit="pts" data={fx.recoveryDrivers} /> },
    ],
  },
  {
    id: "tick-scale",
    name: "TickScale",
    file: "src/components/metrics/TickScale.tsx",
    use: "Healthspan's Pace of Aging and Strain's training load (marker), Home's Energy Bank (meter).",
    props: ["variant: marker | meter", "label, metric, min, max, format, unit", "bands (marker)", "ends, leading, trailing", "describe"],
    states: [
      {
        name: "marker: Pace of Aging",
        node: (
          <TickScale
            variant="marker"
            label="Pace of Aging"
            metric={fx.ok(0.8)}
            min={-1}
            max={3}
            format="decimal1"
            unit="x"
            describe="aging slower than your 6-month average"
            ends={["−1.0x", "1.0x", "3.0x"]}
            leading={<><Turtle aria-hidden strokeWidth={1.75} />Slow</>}
            trailing={<>Fast<Rabbit aria-hidden strokeWidth={1.75} /></>}
          />
        ),
      },
      {
        name: "marker with bands (ACWR), provisional",
        node: (
          <TickScale
            variant="marker"
            label="Training load"
            metric={fx.ok(1.12, { provisional: true })}
            min={0}
            max={2}
            format="decimal2"
            bands={[{ from: 0.8, to: 1.3, tone: "optimal" }, { from: 1.5, to: 2, tone: "warning" }]}
            ends={["0.0", "1.0", "2.0"]}
          />
        ),
      },
      {
        name: "meter: 0, 24, 62, 100",
        node: (
          <div className="space-y-4">
            {[0, 24, 62, 100].map((v) => (
              <TickScale key={v} variant="meter" label="Energy" metric={fx.ok(v)} min={0} max={100} format="int" unit="%" />
            ))}
          </div>
        ),
      },
      {
        name: "marker past both ends",
        node: (
          <div className="space-y-4">
            <TickScale variant="marker" label="Pace of Aging" metric={fx.ok(-1.6)} min={-1} max={3} format="decimal1" unit="x" ends={["−1.0x", "3.0x"]} />
            <TickScale variant="marker" label="Pace of Aging" metric={fx.ok(3.4)} min={-1} max={3} format="decimal1" unit="x" ends={["−1.0x", "3.0x"]} />
          </div>
        ),
      },
      {
        name: "every reason code, then loading",
        node: (
          <div className="space-y-4">
            {reasons.map(({ r, metric }) => (
              <TickScale key={r} variant="meter" label="Energy" metric={metric} min={0} max={100} format="int" unit="%" />
            ))}
            <TickScale variant="meter" label="Energy" metric={undefined} min={0} max={100} format="int" unit="%" />
            <TickScale variant="marker" label="Pace of Aging" metric={undefined} min={-1} max={3} format="decimal1" />
          </div>
        ),
      },
      { name: "meter at 320 px", narrow: true, node: <TickScale variant="meter" label="Energy" metric={fx.ok(62)} min={0} max={100} format="int" unit="%" /> },
    ],
  },
  {
    id: "day-strip",
    name: "DayStrip",
    file: "src/components/metrics/DayStrip.tsx",
    use: "Home's recovery strip and Journal's check-in strip: the last 30 days, links to ?d=.",
    props: ["indicator: recovery | journal", "days: { date, recovery?, done? }[]"],
    states: [
      { name: "recovery", full: true, node: <DayStrip indicator="recovery" days={fx.stripDays} /> },
      { name: "journal", full: true, node: <DayStrip indicator="journal" days={fx.stripDays} /> },
      { name: "recovery, no scores yet", full: true, node: <DayStrip indicator="recovery" days={fx.stripDays.map((d) => ({ ...d, recovery: null }))} /> },
      { name: "loading", full: true, node: <DayStripSkeleton /> },
      { name: "at 320 px", narrow: true, node: <DayStrip indicator="recovery" days={fx.stripDays} /> },
    ],
  },
  {
    id: "insight-card",
    name: "InsightCard",
    file: "src/components/metrics/InsightCard.tsx",
    use: "The coach card under Recovery, Strain, Sleep, Stress and Healthspan heroes, and Home's day banner.",
    props: ["title?", "body", "action?: { label, href }"],
    states: [
      { name: "title, body, action", node: <InsightCard {...fx.insight} /> },
      { name: "body only", node: <InsightCard body="Early estimate: your Pace of Aging slowed by 0.4x this week, mostly from VO2 max." /> },
      { name: "loading", node: <InsightCard.Skeleton title action /> },
      {
        name: "long copy at 320 px",
        narrow: true,
        node: (
          <InsightCard
            title="Recovery is lower than usual"
            body="Your resting heart rate is 6 bpm above your baseline and HRV is down by a fifth, after a late, short night. Light movement and an early night help most."
            action={{ label: "See what shaped it", href: "#drivers" }}
          />
        ),
      },
    ],
  },
  {
    id: "activity-card",
    name: "ActivityCard",
    file: "src/components/metrics/ActivityCard.tsx",
    use: "Home's “Today's activities” and Strain's activity list; links to /activity/[id].",
    props: ["name, kind: run | ride | walk | strength | workout", "strain: Metric<number>", "start, end, timeZone", "distanceKm, paceS", "href"],
    states: [
      {
        name: "run with pace, strength without strain (reason), ride without distance",
        node: (
          <div className="space-y-1.5">
            <ActivityCard {...fx.timeline.run} timeZone={fx.TZ} />
            <ActivityCard {...fx.timeline.strength} timeZone={fx.TZ} />
            <ActivityCard name="Cycling" kind="ride" strain={fx.ok(21)} start={fx.DAY0 + 6 * 3_600_000} end={fx.DAY0 + 9 * 3_600_000 + 42 * 60_000} href="/activity/ride-1" timeZone={fx.TZ} />
            <ActivityCard name="Workout" kind="workout" strain={fx.ok(0)} start={fx.DAY0 + 20 * 3_600_000} end={fx.DAY0 + 20 * 3_600_000 + 4 * 60_000} href="/activity/w-1" timeZone={fx.TZ} />
          </div>
        ),
      },
      { name: "loading", node: <ActivityCard.Skeleton /> },
      {
        name: "long name at 320 px",
        narrow: true,
        node: <ActivityCard name="High-intensity interval training" kind="workout" strain={fx.ok(14.6)} start={fx.DAY0 + 17 * 3_600_000} end={fx.DAY0 + 18 * 3_600_000} href="/activity/w-2" timeZone={fx.TZ} distanceKm={12.04} paceS={298} />,
      },
    ],
  },
  {
    id: "sleep-card",
    name: "SleepCard",
    file: "src/components/metrics/SleepCard.tsx",
    use: "Sleeps and naps on Home's day timeline; links to /sleep?d=.",
    props: ["kind: sleep | nap", "minutes", "start, end, timeZone", "href"],
    states: [
      {
        name: "sleep and nap",
        node: (
          <div className="space-y-1.5">
            <SleepCard {...fx.timeline.sleep} timeZone={fx.TZ} />
            <SleepCard {...fx.timeline.nap} timeZone={fx.TZ} />
          </div>
        ),
      },
      { name: "loading", node: <SleepCard.Skeleton /> },
      { name: "a 13-hour sleep at 320 px", narrow: true, node: <SleepCard kind="sleep" minutes={781} start={fx.DAY0 - 2 * 3_600_000} end={fx.DAY0 + 11 * 3_600_000} href="/sleep" timeZone={fx.TZ} /> },
    ],
  },
  {
    id: "sleep-stages",
    name: "SleepStages",
    file: "src/components/metrics/SleepStages.tsx",
    use: "Sleep's “Last night's sleep” card: hours hero, overnight heart rate and the stage rows.",
    props: ["hours: Metric<SleepHours>", "hr: Metric<SleepHr>", "data: Metric<SleepStagesNight> | null"],
    states: [
      { name: "a staged night", full: true, node: <SleepStages hours={fx.sleepHours} hr={fx.ok(fx.sleepHr)} data={fx.ok(fx.sleepStagesNight)} /> },
      { name: "unstaged night (data null)", node: <SleepStages hours={fx.sleepHours} hr={fx.ok(fx.sleepHr)} data={null} /> },
      { name: "no heart rate", node: <SleepStages hours={fx.sleepHours} hr={fx.why("insufficient_hr_data")} data={fx.ok(fx.sleepStagesNight)} /> },
      {
        name: "every reason code (the whole card)",
        node: (
          <div className="space-y-2">
            {REASON_CODES.map((r) => (
              <SleepStages key={r} hours={fx.why(r, 4)} hr={undefined} data={undefined} />
            ))}
          </div>
        ),
      },
      { name: "loading", node: <SleepStages hours={undefined} hr={undefined} data={undefined} /> },
      { name: "at 320 px", narrow: true, node: <SleepStages hours={fx.sleepHours} hr={fx.ok(fx.sleepHr)} data={fx.ok(fx.sleepStagesNight)} /> },
    ],
  },
  {
    id: "age-orb",
    name: "AgeOrb",
    file: "src/components/metrics/AgeOrb.tsx",
    use: "The Pulse Age hero on Healthspan (300 px), the Health hub (140 px) and its sticky header (compact).",
    props: ["age, deltaYears", "provisional", "size (px)", "reason", "compact"],
    cols: 3,
    states: [
      { name: "8.9 younger: green", center: true, node: <AgeOrb age={27.6} deltaYears={-8.9} size={220} /> },
      { name: "4 younger: blue-green", center: true, node: <AgeOrb age={32.5} deltaYears={-4} size={220} /> },
      { name: "1.5 younger: cyan", center: true, node: <AgeOrb age={35} deltaYears={-1.5} size={220} /> },
      { name: "level: blue", center: true, node: <AgeOrb age={36.5} deltaYears={0} size={220} /> },
      { name: "1.5 older: blue over warm", center: true, node: <AgeOrb age={38} deltaYears={1.5} size={220} /> },
      { name: "3.1 older, provisional: amber-brown", center: true, node: <AgeOrb age={41.6} deltaYears={3.1} provisional size={220} /> },
      { name: "7 older: rust", center: true, node: <AgeOrb age={43.5} deltaYears={7} size={220} /> },
      { name: "12 older: red", center: true, node: <AgeOrb age={48.5} deltaYears={12} size={220} /> },
      { name: "reason", center: true, node: <AgeOrb age={null} deltaYears={null} reason="calibrating" size={220} /> },
      { name: "Health hub size (drops the delta line)", center: true, node: <AgeOrb age={36.5} deltaYears={0.2} size={140} /> },
      { name: "compact (sticky header)", center: true, node: <AgeOrb age={34.1} deltaYears={-2.4} compact /> },
    ],
  },
  {
    id: "connection-banner",
    name: "ConnectionBanner",
    file: "src/components/metrics/ConnectionBanner.tsx",
    use: "The top of every page while Google is not connected, importing, revoked or stale. Never in demo mode.",
    props: ["className", "reads ShellStatus: connection, importProgress"],
    states: fx.googleStatuses.map(({ name, status }) => ({
      name,
      node: (
        <ShellStatusProvider value={status}>
          <ConnectionBanner />
          {status.connection === "connected" && <p className="text-xs leading-4 font-medium text-muted-foreground">Connected: no banner.</p>}
        </ShellStatusProvider>
      ),
    })),
  },
  {
    id: "reason-placeholder",
    name: "ReasonPlaceholder",
    file: "src/components/metrics/ReasonPlaceholder.tsx",
    use: "Every reason state, through MetricState: sm in rows, md in cards, lg for a whole screen.",
    props: ["reason: any string (unknown falls back to no_data)", "nightsLeft", "size: sm | md | lg", "copy (screen's own wording)"],
    states: [
      {
        name: "sm, every reason code",
        node: (
          <div className="space-y-3">
            {REASON_CODES.map((r) => (
              <ReasonPlaceholder key={r} reason={r} nightsLeft={4} size="sm" />
            ))}
          </div>
        ),
      },
      {
        name: "md, every reason code",
        node: (
          <div className="space-y-4">
            {REASON_CODES.map((r) => (
              <ReasonPlaceholder key={r} reason={r} nightsLeft={1} size="md" />
            ))}
          </div>
        ),
      },
      { name: "lg", node: <ReasonPlaceholder reason="no_hrv_last_night" size="lg" /> },
      {
        name: "unknown code, custom copy",
        node: (
          <div className="space-y-3">
            <ReasonPlaceholder reason="unknown_code" size="md" />
            <ReasonPlaceholder reason="calibrating" size="sm" copy="Forecast starts after 14 nights." />
          </div>
        ),
      },
    ],
  },
  {
    id: "primitives",
    name: "Tag, MetricTags, StatusChip, DeltaMark, ValueUnit",
    file: "src/components/metrics/primitives.tsx",
    use: "The small marks every kit component shares: status tags, range chips, delta arrows and value-unit pairs.",
    props: ["Tag kind", "MetricTags provisional, tags, extra", "StatusChip tone: optimal | warning | alert | neutral, delta", "DeltaMark dir, tone", "ValueUnit value, unit"],
    states: [
      {
        name: "Tags (one look per meaning, never coloured)",
        node: (
          <div className="flex flex-wrap gap-2">
            {(["provisional", "stale_baseline", "updated", "so_far", "partial_week", "partial_month", "estimate"] as const).map((k) => (
              <Tag key={k} kind={k} />
            ))}
          </div>
        ),
      },
      { name: "MetricTags (wraps and centres)", narrow: true, node: <MetricTags provisional tags={["stale_baseline", "updated"]} extra={["so_far"]} /> },
      {
        name: "StatusChip tones and a delta",
        node: (
          <div className="flex flex-wrap gap-2">
            <StatusChip tone="optimal">within 16.1 - 16.9</StatusChip>
            <StatusChip tone="warning">Out of range</StatusChip>
            <StatusChip tone="alert">Illness signal</StatusChip>
            <StatusChip tone="neutral" delta="up">151 bpm</StatusChip>
          </div>
        ),
      },
      {
        name: "DeltaMark: good, bad, neutral, flat",
        node: (
          <div className="flex items-center gap-4">
            <DeltaMark dir="up" tone="good" />
            <DeltaMark dir="down" tone="bad" />
            <DeltaMark dir="up" tone="neutral" />
            <DeltaMark dir="flat" tone="neutral" />
          </div>
        ),
      },
      {
        name: "ValueUnit: word unit, symbol unit, missing",
        node: (
          <div className="flex flex-wrap items-baseline gap-6 font-numeric text-xl font-bold">
            <ValueUnit value="124" unit="ms" />
            <ValueUnit value="97" unit="%" />
            <ValueUnit value="--" unit="bpm" className="text-muted-foreground" />
          </div>
        ),
      },
    ],
  },
]
