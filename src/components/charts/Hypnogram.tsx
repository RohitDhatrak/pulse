"use client"

import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts"
import { DATA_COLORS } from "@/lib/bands"
import { hourTicks, hypnogramSeries, STAGES, type Stage, type StageSegment } from "@/lib/charts"
import { clock, durationWords } from "@/lib/format"
import type { Metric } from "@/lib/reasons"
import { ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/shells/EmptyState"
import { MetricState } from "@/components/shells/MetricState"
import { useOptionalShellCalendar } from "@/components/shells/ShellStatus"
import { ReasonPlaceholder } from "@/components/metrics/ReasonPlaceholder"
import { AXIS, ChartFigure, GRID, LINE_CURSOR, TOOLTIP_CLASS, TooltipLine, useSeriesAnimation } from "./ChartFrame"

export type HypnogramNight = { bed: number; wake: number; segments: StageSegment[] }
export type HypnogramProps = {
  /** null or no segments: the night has no stage data (Fitbit only stages sleeps over about 3 h). */
  data: Metric<HypnogramNight> | null | undefined
}

const STAGE_NAME: Record<Stage, string> = { awake: "Awake", rem: "REM", light: "Light", deep: "Deep" }
const LANE_NAME = ["Deep", "Light", "REM", "Awake"]
const LANE_STAGE: Stage[] = ["deep", "light", "rem", "awake"]

/**
 * The night as one step line over four lanes, Awake on top to Deep at the bottom, as sleep apps draw it. Hover, tap or
 * arrow keys (the chart is a tab stop) step through the stretches; the tooltip names the stage and its times.
 */
export function HypnogramChart({ night }: { night: HypnogramNight }) {
  const tz = useOptionalShellCalendar()?.timeZone
  const anim = useSeriesAnimation()
  const span = night.wake - night.bed
  // Hours between the bed and wake times: every other hour past 7 h, none within 24% of either end, so the bold end
  // times never touch a neighbour even at 320 px.
  const hours = hourTicks(night.bed, night.wake, span > 7 * 3_600_000 ? 2 : 1, tz).filter((h) => h - night.bed > span * 0.24 && night.wake - h > span * 0.24)
  const { connector, stages } = hypnogramSeries(night.segments)
  const total = night.segments.reduce((a, s) => a + (s.end - s.start), 0)
  const minutes = (st: Stage) => night.segments.filter((s) => s.stage === st).reduce((a, s) => a + s.end - s.start, 0) / 60_000
  const summary = `Sleep stages from ${clock(night.bed, tz)} to ${clock(night.wake, tz)}, ${night.segments.length} stretches: ${STAGES.map(
    (s) => `${STAGE_NAME[s]} ${durationWords(minutes(s))}, ${Math.round(((minutes(s) * 60_000) / (total || 1)) * 100)} percent`
  ).join("; ")}.`
  // The connector's last point is the wake time, the end of the last stretch: it reads as that stretch.
  const segAt = (t: number) => night.segments.find((s) => s.start <= t && t < s.end) ?? night.segments.findLast((s) => s.end === t)

  return (
    <ChartFigure summary={summary} config={{}} className="h-44">
      <LineChart data={connector} accessibilityLayer margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid {...GRID} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={[night.bed, night.wake]}
          // Bed and wake times at the ends, bold (WHOOP), and the whole hours between that keep clear of them.
          ticks={[night.bed, ...hours, night.wake]}
          interval={0}
          tick={({ x, y, payload }: { x?: number | string; y?: number | string; payload?: { value: number } }) => {
            const v = Number(payload?.value)
            const edge = v === night.bed || v === night.wake
            return (
              <text x={x} y={y} dy="0.71em" textAnchor={v === night.bed ? "start" : v === night.wake ? "end" : "middle"} fontSize={12} fontWeight={edge ? 700 : 500} fill={edge ? "var(--foreground)" : "var(--muted-foreground)"}>
                {clock(v, tz)}
              </text>
            )
          }}
          {...AXIS}
        />
        <YAxis
          type="number"
          domain={[0, 3]}
          ticks={[3, 2, 1, 0]}
          width={52}
          {...AXIS}
          // Each lane named in its stage colour, so the label doubles as the legend.
          tick={({ x, y, payload }: { x?: number | string; y?: number | string; payload?: { value: number } }) => {
            const v = Number(payload?.value)
            return (
              <text x={x} y={y} dy="0.32em" textAnchor="end" fontSize={11} fontWeight={700} fill={LANE_STAGE[v] ? DATA_COLORS[`stage-${LANE_STAGE[v]}`].css : "var(--muted-foreground)"}>
                {LANE_NAME[v] ?? ""}
              </text>
            )
          }}
        />
        <ChartTooltip
          isAnimationActive={false}
          cursor={LINE_CURSOR}
          content={
            <ChartTooltipContent
              className={TOOLTIP_CLASS}
              hideIndicator
              labelFormatter={(_, payload) => {
                const s = segAt(Number(payload?.[0]?.payload?.t))
                return s ? `${clock(s.start, tz)} to ${clock(s.end, tz)}` : ""
              }}
              formatter={(_, __, item) => {
                const s = segAt(Number((item.payload as { t: number }).t))
                if (!s) return null
                return (
                  <TooltipLine color={DATA_COLORS[`stage-${s.stage}`].css}>
                    {STAGE_NAME[s.stage]}, {Math.round((s.end - s.start) / 60000)} min
                  </TooltipLine>
                )
              }}
            />
          }
        />
        {/* A faint track under each lane (Google Health's sleep chart), so a short stretch still reads as its row. */}
        {LANE_STAGE.map((_, lane) => (
          <ReferenceLine key={lane} y={lane} stroke="color-mix(in srgb, var(--foreground) 7%, transparent)" strokeWidth={14} />
        ))}
        <Line dataKey="lane" type="stepAfter" stroke="color-mix(in srgb, var(--foreground) 22%, transparent)" strokeWidth={1} dot={false} activeDot={false} {...anim} />
        {STAGES.map((st) => (
          <Line
            key={st}
            data={stages[st]}
            dataKey="lane"
            type="stepAfter"
            stroke={DATA_COLORS[`stage-${st}`].css}
            strokeWidth={14}
            strokeLinecap="butt"
            dot={false}
            activeDot={false}
            connectNulls={false}
            tooltipType="none"
            {...anim}
          />
        ))}
      </LineChart>
    </ChartFigure>
  )
}

/** Last night's stages as a step chart over four lanes (spec §5.6, derived design). */
export function Hypnogram({ data }: HypnogramProps) {
  const empty = (
    <div className="grid place-items-center">
      <EmptyState body="No stage data for this night. Fitbit only stages sleeps longer than about 3 hours." />
    </div>
  )
  return (
    <MetricState
      metric={data}
      skeleton={<HypnogramSkeleton />}
      empty={empty}
      renderReason={(r) => (
        <div className="grid place-items-center">
          <ReasonPlaceholder reason={r} size="md" />
        </div>
      )}
    >
      {(night) => (night.segments.length ? <HypnogramChart night={night} /> : empty)}
    </MetricState>
  )
}

export function HypnogramSkeleton() {
  return <Skeleton aria-hidden className="h-44 rounded-lg bg-muted/60" />
}
Hypnogram.Skeleton = HypnogramSkeleton
