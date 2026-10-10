"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts"
import { cn } from "@/lib/utils"
import { clock } from "@/lib/format"
import { useOptionalShellCalendar } from "@/components/shells/ShellStatus"
import { CAPTION, LABEL } from "@/components/metrics/primitives"
import { ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { AXIS, ChartFigure, GlowDot, GRID, LINE_CURSOR, Pill, TOOLTIP_CLASS, TooltipLine, useSeriesAnimation } from "./ChartFrame"

/** One night's samples across the main sleep (scoring version 35): Fitbit's HRV or SpO2. A null point is a gap. */
export type NightLine = {
  bed: number
  wake: number
  points: { t: number; v: number | null }[]
  low: { t: number; v: number | null }
  high: { t: number; v: number | null }
  median: number
}

export type NightLineChartProps = {
  /** "hrv": ms, the high marked (the night's best recovery stretch); "spo2": %, the low marked (the dip people look for). */
  kind: "hrv" | "spo2"
  night: NightLine
  className?: string
}

const KIND = {
  hrv: { title: "Overnight HRV", unit: "ms", spoken: "milliseconds", step: 10, mark: "high", fmt: (v: number) => Math.round(v).toString() },
  spo2: { title: "Overnight blood oxygen", unit: "%", spoken: "percent", step: 2, mark: "low", fmt: (v: number) => v.toFixed(1) },
} as const

/**
 * A night of HRV or SpO2 samples between the bed and wake markers, like the overnight heart rate above it (spec §7.5,
 * §7.8). HRV marks its high and says its median, which is Fitbit's nightly HRV; SpO2 marks its low.
 */
export function NightLineChart({ kind, night, className }: NightLineChartProps) {
  const tz = useOptionalShellCalendar()?.timeZone
  const anim = useSeriesAnimation()
  const id = React.useId().replace(/:/g, "")
  const k = KIND[kind]
  const values = night.points.flatMap((p) => (p.v === null ? [] : [p.v]))
  const lo = Math.floor((Math.min(...values) - k.step / 2) / k.step) * k.step
  const hi = kind === "spo2" ? 100 : Math.ceil((Math.max(...values) + k.step / 2) / k.step) * k.step
  const yTicks = Array.from({ length: Math.round((hi - lo) / k.step) + 1 }, (_, i) => lo + i * k.step)
  const mark = k.mark === "high" ? night.high : night.low
  const markText = `${k.mark === "high" ? "High" : "Low"} ${k.fmt(mark.v ?? 0)}${kind === "spo2" ? "%" : ""}`
  const caption =
    kind === "hrv"
      ? `Median ${k.fmt(night.median)} ms, Fitbit’s nightly HRV`
      : `Median ${k.fmt(night.median)}%, low ${k.fmt(night.low.v ?? 0)}%`
  const summary = `${k.title} from ${clock(night.bed, tz)} to ${clock(night.wake, tz)}: low ${k.fmt(night.low.v ?? 0)}, median ${k.fmt(night.median)}, high ${k.fmt(night.high.v ?? 0)} ${k.spoken}.`

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className={cn(LABEL, "text-foreground-secondary")}>{k.title}</h3>
        <span className={cn(CAPTION, "tabular-nums")}>{caption}</span>
      </div>
      <ChartFigure summary={summary} config={{ v: { label: k.title, color: "var(--foreground)" } }} className="h-[140px]">
        <AreaChart data={night.points} accessibilityLayer margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`night-${kind}-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--foreground)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--foreground)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid {...GRID} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[night.bed, night.wake]}
            ticks={[night.bed, night.wake]}
            tickFormatter={(v: number) => clock(v, tz)}
            {...AXIS}
            tick={{ fill: "var(--foreground-secondary)" }}
          />
          <YAxis domain={[yTicks[0], yTicks.at(-1)!]} ticks={yTicks} width={32} {...AXIS} />
          {kind === "hrv" && <ReferenceLine y={night.median} stroke="var(--foreground-secondary)" strokeDasharray="2 3" ifOverflow="hidden" />}
          {mark.v !== null && (
            <ReferenceDot
              x={mark.t}
              y={mark.v}
              r={3.5}
              fill="var(--foreground)"
              stroke="var(--card)"
              strokeWidth={2}
              label={({ viewBox }: { viewBox?: { x?: number; y?: number; width?: number; height?: number } }) => {
                const x = (viewBox?.x ?? 0) + (viewBox?.width ?? 0) / 2
                const y = (viewBox?.y ?? 0) + (viewBox?.height ?? 0) / 2
                return <Pill x={x} y={k.mark === "high" ? y + 16 : y - 16} anchor="middle" text={markText} />
              }}
            />
          )}
          <ChartTooltip
            isAnimationActive={false}
            cursor={LINE_CURSOR}
            content={
              <ChartTooltipContent
                className={TOOLTIP_CLASS}
                hideIndicator
                labelFormatter={(_, payload) => clock(Number(payload?.[0]?.payload?.t), tz)}
                formatter={(v) => (
                  <TooltipLine color="var(--foreground)">
                    {k.fmt(Number(v))}
                    {kind === "spo2" ? "%" : " ms"}
                  </TooltipLine>
                )}
              />
            }
          />
          <Area
            dataKey="v"
            type="monotone"
            stroke="var(--foreground)"
            strokeWidth={1.5}
            fill={`url(#night-${kind}-${id})`}
            connectNulls={false}
            activeDot={(d: { cx?: number; cy?: number }) => <GlowDot cx={d.cx} cy={d.cy} fill="var(--foreground)" />}
            {...anim}
          />
        </AreaChart>
      </ChartFigure>
    </div>
  )
}
