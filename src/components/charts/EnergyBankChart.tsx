"use client"

import * as React from "react"
import { Area, CartesianGrid, ComposedChart, Line, ReferenceDot, XAxis, YAxis } from "recharts"
import { DATA_COLORS, recoveryColor } from "@/lib/bands"
import { bandColor, hourTicks } from "@/lib/charts"
import { clock, formatValue } from "@/lib/format"
import type { Metric } from "@/lib/reasons"
import { ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/shells/EmptyState"
import { MetricState } from "@/components/shells/MetricState"
import { useOptionalShellCalendar } from "@/components/shells/ShellStatus"
import { ReasonPlaceholder } from "@/components/metrics/ReasonPlaceholder"
import { AXIS, BandGradient, bandPaint, ChartFigure, FadeGradient, GlowDot, GRID, LINE_CURSOR, Pill, TOOLTIP_CLASS, TooltipLine, useSeriesAnimation, type Band } from "./ChartFrame"
import { spanAreas } from "./IntradayHrChart"

export type EnergySeries = {
  /** Reserve 0-100 from wake to now (today) or to sleep (past days). */
  points: { t: number; value: number | null }[]
  /** Drains; the chart annotates the three biggest. `amount` is positive ("−18 Run" for 18). */
  drains?: { t: number; amount: number; label: string }[]
  naps?: { start: number; end: number }[]
}

export type EnergyBankChartProps = { data: Metric<EnergySeries> | null | undefined }

// Energy bands like Recovery: red ≤ 33, yellow 34-66, green ≥ 67.
const BANDS: Band[] = [0, 34, 67].map((from) => ({ from, color: DATA_COLORS[recoveryColor(from)].css }))

function Chart({ e }: { e: EnergySeries }) {
  const tz = useOptionalShellCalendar()?.timeZone
  const anim = useSeriesAnimation()
  const id = React.useId().replace(/:/g, "")
  const data = e.points.map((p) => ({ x: p.t, all: p.value }))
  const vals = e.points.flatMap((p) => (p.value === null ? [] : [p.value]))
  const top = Math.max(...vals)
  const bottom = Math.min(...vals)
  const first = e.points[0]?.t ?? 0
  const last = e.points.at(-1)?.t ?? 0
  const latest = [...e.points].reverse().find((p) => p.value !== null)
  const valueAt = (t: number) => e.points.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best), e.points[0]).value
  const drains = [...(e.drains ?? [])].sort((a, b) => b.amount - a.amount).slice(0, 3)
  const startV = e.points.find((p) => p.value !== null)?.value
  const summary = `Energy from ${clock(first, tz)}: started at ${formatValue("int", startV)} percent, now ${formatValue("int", latest?.value)} percent.`

  return (
    <ChartFigure summary={summary} config={{ all: { label: "Energy", color: "var(--recovery-green)" } }} className="h-[140px]">
      <ComposedChart data={data} accessibilityLayer margin={{ top: 18, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid {...GRID} />
        <defs>
          <BandGradient id={`energy-${id}`} top={top} bottom={bottom} bands={BANDS} />
          <FadeGradient id={`energy-fill-${id}`} color={bandColor(latest?.value ?? top, BANDS)} from={0.24} />
        </defs>
        {spanAreas(e.naps?.map((n) => ({ kind: "sleep" as const, start: n.start, end: n.end, label: "Nap" })))}
        <XAxis dataKey="x" type="number" scale="time" domain={[first, last]} ticks={hourTicks(first, last, 6, tz)} tickFormatter={(v: number) => clock(v, tz)} interval="preserveStartEnd" minTickGap={24} {...AXIS} />
        <YAxis domain={[0, 100]} ticks={[33, 67, 100]} width={28} {...AXIS} tickMargin={4} />
        <ChartTooltip
          isAnimationActive={false}
          cursor={LINE_CURSOR}
          content={
            <ChartTooltipContent
              className={TOOLTIP_CLASS}
              hideIndicator
              labelFormatter={(_, payload) => clock(Number(payload?.[0]?.payload?.x), tz)}
              formatter={(v, name) =>
                name === "all" ? <TooltipLine color={DATA_COLORS[recoveryColor(Number(v))].css}>{formatValue("int", Number(v))}%</TooltipLine> : null
              }
            />
          }
        />
        <Area dataKey="all" type="monotone" stroke="none" fill={`url(#energy-fill-${id})`} connectNulls={false} activeDot={false} tooltipType="none" {...anim} />
        <Line
          dataKey="all"
          type="monotone"
          stroke={bandPaint(`energy-${id}`, top, bottom, BANDS)}
          strokeWidth={2}
          dot={false}
          activeDot={(d: { cx?: number; cy?: number; payload?: { all: number | null } }) => <GlowDot cx={d.cx} cy={d.cy} fill={bandPaint("", d.payload?.all ?? 0, d.payload?.all ?? 0, BANDS)} />}
          connectNulls={false}
          {...anim}
        />
        {drains.map((d) => {
          const y = valueAt(d.t)
          return y === null ? null : (
            <ReferenceDot
              key={d.t}
              x={d.t}
              y={y}
              r={3}
              fill="var(--warning)"
              stroke="none"
              // A pill chip above the point, so the drain reads as a marker, not loose text over the line.
              label={({ viewBox }: { viewBox?: { x?: number; y?: number; width?: number } }) => (
                <Pill
                  x={(viewBox?.x ?? 0) + (viewBox?.width ?? 0) / 2}
                  y={(viewBox?.y ?? 0) - 12}
                  anchor="middle"
                  text={`${formatValue("int", -d.amount)} ${d.label}`}
                  fill="color-mix(in srgb, var(--warning) 16%, var(--card))"
                  color="var(--warning)"
                />
              )}
            />
          )
        })}
        {latest?.value != null && (
          <ReferenceDot x={latest.t} y={latest.value} r={4} fill={DATA_COLORS[recoveryColor(latest.value)].css} stroke="var(--card)" strokeWidth={2} />
        )}
      </ComposedChart>
    </ChartFigure>
  )
}

/** another app's Energy Bank in the reference app's language (spec §5.9). */
export function EnergyBankChart({ data }: EnergyBankChartProps) {
  const empty = (
    <div className="grid place-items-center">
      <EmptyState body="Energy Bank starts once you wake up." />
    </div>
  )
  return (
    <MetricState
      metric={data}
      skeleton={<EnergyBankChartSkeleton />}
      empty={empty}
      renderReason={(r, meta) => (
        <div className="grid place-items-center">
          <ReasonPlaceholder reason={r} nightsLeft={meta.nightsLeft} size="md" />
        </div>
      )}
    >
      {(e) => (e.points.some((p) => p.value !== null) ? <Chart e={e} /> : empty)}
    </MetricState>
  )
}

export function EnergyBankChartSkeleton() {
  return <Skeleton aria-hidden className="h-[140px] rounded-lg" />
}
EnergyBankChart.Skeleton = EnergyBankChartSkeleton
