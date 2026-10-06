"use client"

import { Bar, CartesianGrid, Cell, ComposedChart, ReferenceLine, XAxis, YAxis } from "recharts"
import { DATA_COLORS } from "@/lib/bands"
import { formatValue, type FormatKey } from "@/lib/format"
import { ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { AXIS, BAR_CURSOR, ChartFigure, GRID, gutterLabel, labelGutter, TOOLTIP_CLASS, TooltipLine, useSeriesAnimation } from "./ChartFrame"

export type Column = {
  /** Axis label ("06:00", "Mon", "Sep 21"). */
  label: string
  /** Tooltip heading; defaults to `label`. */
  title?: string
  value: number | null
  /** The column the card is about (the selected hour, the best weekday, this week): full colour; the rest muted. */
  highlight?: boolean
}

export type ColumnChartProps = {
  /** The figure's spoken summary. */
  summary: string
  data: Column[]
  format: FormatKey
  unit?: string
  /** Show every `tickEvery`-th label (hours: 6). */
  tickEvery?: number
  /** A dashed target line ("150 min"). */
  reference?: { y: number; label: string }
}

const ON = DATA_COLORS["chart-5"].css
const OFF = "var(--dial-track)"

/**
 * Category columns: steps by hour, the weekday pattern, weekly totals against a target (metric detail, spec §11 MD1).
 * Columns with `highlight` take the data colour; when none is highlighted every column does.
 */
export function ColumnChart({ summary, data, format, unit, tickEvery = 1, reference }: ColumnChartProps) {
  const anim = useSeriesAnimation()
  const any = data.some((d) => d.highlight)
  const rows = data.map((d, i) => ({ ...d, key: `${i}`, fill: !any || d.highlight ? ON : OFF }))
  const ticks = rows.filter((_, i) => i % tickEvery === 0).map((r) => r.key)
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const unitText = unit ? (unit === "%" ? "%" : ` ${unit}`) : ""
  return (
    <ChartFigure summary={summary} config={{ value: { label: summary, color: ON } }} className="h-44">
      <ComposedChart data={rows} accessibilityLayer margin={{ top: 8, right: labelGutter([reference?.label], 12), bottom: 0, left: 12 }}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="key" {...AXIS} ticks={ticks} interval={0} tickFormatter={(k: string) => byKey.get(k)?.label ?? ""} />
        <YAxis hide domain={[0, (max: number) => Math.max(max, reference?.y ?? 0)]} />
        {reference && (
          <ReferenceLine
            y={reference.y}
            stroke="var(--chart-cursor)"
            strokeDasharray="3 3"
            label={gutterLabel(reference.label)}
          />
        )}
        <ChartTooltip
          isAnimationActive={false}
          cursor={BAR_CURSOR}
          content={
            <ChartTooltipContent
              className={TOOLTIP_CLASS}
              hideIndicator
              labelFormatter={(_, payload) => {
                const r = payload?.[0]?.payload as (typeof rows)[number] | undefined
                return r ? (r.title ?? r.label) : ""
              }}
              formatter={(_, __, item) => {
                const r = item.payload as (typeof rows)[number]
                return (
                  <TooltipLine color={r.fill}>
                    {r.value === null ? "No data" : `${formatValue(format, r.value)}${unitText}`}
                  </TooltipLine>
                )
              }}
            />
          }
        />
        {/* A dim full-height track behind each column, so the scale reads without a y-axis. */}
        <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={28} background={{ fill: "color-mix(in srgb, var(--foreground) 4%, transparent)", radius: 4 }} {...anim}>
          {rows.map((r) => (
            <Cell key={r.key} fill={r.fill} />
          ))}
        </Bar>
      </ComposedChart>
    </ChartFigure>
  )
}

export function ColumnChartSkeleton() {
  return <Skeleton aria-hidden className="h-44 rounded-lg bg-muted/60" />
}
ColumnChart.Skeleton = ColumnChartSkeleton
