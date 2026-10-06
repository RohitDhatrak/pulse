"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts"
import { paddedDomain } from "@/lib/charts"
import { clock } from "@/lib/format"
import type { Metric } from "@/lib/reasons"
import { ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/shells/EmptyState"
import { MetricState } from "@/components/shells/MetricState"
import { useOptionalShellCalendar } from "@/components/shells/ShellStatus"
import { ReasonPlaceholder } from "@/components/metrics/ReasonPlaceholder"
import { AXIS, ChartFigure, GlowDot, GRID, LINE_CURSOR, Pill, TOOLTIP_CLASS, TooltipLine, useSeriesAnimation } from "./ChartFrame"

export type SleepHr = {
  /** Epoch ms of the main sleep's start and end. */
  bed: number
  wake: number
  /** Per-minute heart rate, a little past both ends; null is a gap, never interpolated. */
  points: { t: number; v: number | null }[]
}

export type SleepHrChartProps = {
  data: Metric<SleepHr> | null | undefined
  /** The chosen stage's intervals: its heart rate is drawn bright with a fill, the rest of the night dim. Omit to light the whole night. */
  highlight?: { start: number; end: number }[]
}

const H = "h-[180px]"
const MIN = 60_000

function Chart({ hr, highlight }: { hr: SleepHr; highlight?: { start: number; end: number }[] }) {
  const tz = useOptionalShellCalendar()?.timeZone
  const anim = useSeriesAnimation()
  const id = React.useId().replace(/:/g, "")
  const { bed, wake, points } = hr
  // Three series on one axis: outside the sleep (faint), the night (dim), the chosen stage (bright, filled).
  // A minute joins a stage when it or the next minute overlaps one, so a 1-minute wake still draws a stroke.
  const rows = React.useMemo(
    () =>
      points.map(({ t, v }) => {
        const inside = t >= bed && t <= wake
        const lit = inside && (!highlight || highlight.some((s) => t < s.end && t + 2 * MIN > s.start))
        return { t, out: inside ? null : v, night: inside ? v : null, lit: lit ? v : null }
      }),
    [points, bed, wake, highlight]
  )
  // Even 20 bpm steps, as in the reference app's 30-50-70-90-110; tickCount alone gave 40, 60, 80, 90.
  const [lo, hi] = paddedDomain(points.map((p) => p.v))
  const yTicks = Array.from({ length: Math.ceil(hi / 20) - Math.floor(lo / 20) + 1 }, (_, i) => (Math.floor(lo / 20) + i) * 20)
  const night = points.filter((p) => p.t >= bed && p.t < wake && p.v !== null).map((p) => p.v!)
  const avg = night.length ? Math.round(night.reduce((a, b) => a + b, 0) / night.length) : null
  // The night's lowest minute, marked as a point with a pill: the number people look for on this chart.
  const low = points.reduce<{ t: number; v: number } | null>((m, p) => (p.t >= bed && p.t < wake && p.v !== null && (!m || p.v < m.v) ? { t: p.t, v: p.v } : m), null)
  const summary = `Heart rate during sleep from ${clock(bed, tz)} to ${clock(wake, tz)}: low ${Math.min(...night)}, average ${avg}, high ${Math.max(...night)} beats per minute.`

  return (
    <ChartFigure summary={summary} config={{ night: { label: "Heart rate", color: "var(--foreground)" } }} className={H}>
      <AreaChart data={rows} accessibilityLayer margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`sleep-hr-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--foreground)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--foreground)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid {...GRID} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={[points[0].t, points.at(-1)!.t]}
          ticks={[bed, wake]}
          tickFormatter={(v: number) => clock(v, tz)}
          {...AXIS}
          tick={{ fill: "var(--foreground-secondary)" }}
        />
        <YAxis domain={[yTicks[0], yTicks.at(-1)!]} ticks={yTicks} width={32} {...AXIS} />
        {low && (
          <ReferenceDot
            x={low.t}
            y={low.v}
            r={3.5}
            fill="var(--foreground)"
            stroke="var(--card)"
            strokeWidth={2}
            label={({ viewBox }: { viewBox?: { x?: number; y?: number; width?: number; height?: number } }) => (
              <Pill x={(viewBox?.x ?? 0) + (viewBox?.width ?? 0) / 2} y={(viewBox?.y ?? 0) + (viewBox?.height ?? 0) + 14} anchor="middle" text={`Low ${low.v}`} />
            )}
          />
        )}
        {/* the reference app's dashed bed and wake markers [latest-sleep-stages-1]. */}
        {[bed, wake].map((x) => (
          <ReferenceLine key={x} x={x} stroke="var(--foreground-secondary)" strokeDasharray="2 3" ifOverflow="hidden" />
        ))}
        <ChartTooltip
          isAnimationActive={false}
          cursor={LINE_CURSOR}
          content={
            <ChartTooltipContent
              className={TOOLTIP_CLASS}
              hideIndicator
              labelFormatter={(_, payload) => clock(Number(payload?.[0]?.payload?.t), tz)}
              formatter={(v) => <TooltipLine color="var(--foreground)">{Number(v)} bpm</TooltipLine>}
            />
          }
        />
        <Area dataKey="out" type="monotone" stroke="var(--muted-foreground)" strokeOpacity={0.45} strokeWidth={1} fill="none" connectNulls={false} {...anim} />
        <Area dataKey="night" type="monotone" stroke="var(--muted-foreground)" strokeWidth={1.25} fill="none" connectNulls={false} {...anim} />
        {/* Not animated: it redraws on every stage choice, and a replayed sweep there reads as lag. */}
        <Area
          dataKey="lit"
          type="monotone"
          stroke="var(--foreground)"
          strokeWidth={1.5}
          fill={`url(#sleep-hr-${id})`}
          connectNulls={false}
          tooltipType="none"
          isAnimationActive={false}
          activeDot={(d: { cx?: number; cy?: number }) => <GlowDot cx={d.cx} cy={d.cy} fill="var(--foreground)" />}
        />
      </AreaChart>
    </ChartFigure>
  )
}

/** Heart rate across the main sleep with its bed and wake markers; the chosen stage lit (spec §7.5, §11 R9). */
export function SleepHrChart({ data, highlight }: SleepHrChartProps) {
  const empty = (
    <div className="grid place-items-center">
      <EmptyState body="No heart-rate data for this night." />
    </div>
  )
  return (
    <MetricState
      metric={data}
      skeleton={<SleepHrChartSkeleton />}
      empty={empty}
      renderReason={(r) => (
        <div className="grid place-items-center">
          <ReasonPlaceholder reason={r} size="md" />
        </div>
      )}
    >
      {(hr) => (hr.points.some((p) => p.v !== null) ? <Chart hr={hr} highlight={highlight} /> : empty)}
    </MetricState>
  )
}

export function SleepHrChartSkeleton() {
  return <Skeleton aria-hidden className={`${H} rounded-lg bg-muted/60`} />
}
SleepHrChart.Skeleton = SleepHrChartSkeleton
