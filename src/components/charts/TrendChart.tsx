"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Area, Bar, CartesianGrid, Cell, ComposedChart, LabelList, Line, Rectangle, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts"
import { cn } from "@/lib/utils"
import { DATA_COLORS, deltaTone, recoveryBand, recoveryColor, STRESS_COLOR, stressLevel, type GoodDirection } from "@/lib/bands"
import { DAY, dayLabel, formatDay, formatValue, spoken, type FormatKey } from "@/lib/format"
import type { Metric } from "@/lib/reasons"
import { parseRange, RANGE_DAYS, withParam, type TrendRange } from "@/lib/url"
import { ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Skeleton, SkeletonText } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { EmptyState } from "@/components/shells/EmptyState"
import { MetricState } from "@/components/shells/MetricState"
import { useOptionalShellCalendar } from "@/components/shells/ShellStatus"
import { StatusChip, ValueUnit } from "@/components/metrics/primitives"
import { AXIS, BAR_CURSOR, BandGradient, bandPaint, ChartFigure, FadeGradient, GlowDot, GRID, gutterLabel, labelGutter, LINE_CURSOR, TOOLTIP_CLASS, TooltipLine, useSeriesAnimation, wholeTick, type Band } from "./ChartFrame"

export type TrendPoint = {
  date: string
  value: number | null
  provisional?: boolean
  /** With `stack`: the parts of `value` by series key; null when the day has a total but no breakdown. */
  parts?: Record<string, number> | null
}
/** One stacked part, bottom first. `color` is a CSS colour (a token's `var()`). */
export type TrendSeries = { key: string; label: string; color: string }

export type TrendChartProps = {
  /** Metric name for the chart summary ("Recovery"). */
  label: string
  /** Up to 182 days ending on `d`, oldest first (U10); the chart slices by range. */
  data: Metric<TrendPoint[]> | null | undefined
  unit?: string
  format: FormatKey
  colorBy: "band" | "strain" | "sleep" | "single" | "stress"
  /** Gives the delta chip a good/bad tone; omit for neutral metrics. */
  direction?: GoodDirection
  /** Change of the range average against the prior range, per range (U10). */
  deltas?: Partial<Record<TrendRange, number | null>>
  /** Shades mean ± 1 σ ("Shaded: your normal range"). */
  baseline?: { mean: number; sd: number } | null
  /** Strain Target band ("Shaded: your Strain Target"). */
  target?: [number, number] | null
  /** Pins one range and hides the toggle (Stress 30-day trend). */
  fixedRange?: TrendRange
  /** Range when `?r=` is absent (default `m`; Fitness VO2 max uses `6m`). */
  defaultRange?: TrendRange
  /** The toggle's ranges (default W, M, 6M; Trends adds 1Y). `data` must hold enough days for the longest. */
  ranges?: readonly TrendRange[]
  /** A labelled horizontal line ("Your age" on Pulse Age history). */
  reference?: { y: number; label: string }
  /**
   * Draws each day's `parts` as stacked bars (W and M; 6M and 1Y draw the total as a line) with a legend of the shown day's split; a day without parts
   * draws its total in a neutral bar and the legend says it has no breakdown (Strain's calories, spec §11 CAL1).
   */
  stack?: readonly TrendSeries[]
  /** `day`: the header shows the selected (last) day's value instead of the range average. */
  headline?: "average" | "day"
  /** Draws a line of the trailing `smooth`-day average over the bars or dots (weight's 7-day average). */
  smooth?: number
}

const RANGE_ARIA: Record<TrendRange, string> = { w: "1 week", m: "1 month", "6m": "6 months", "1y": "1 year" }
const RANGE_PRIOR: Record<TrendRange, string> = { w: "vs. prior week", m: "vs. prior month", "6m": "vs. prior 6 months", "1y": "vs. prior year" }
const RANGE_WORD: Record<TrendRange, string> = { w: "week", m: "month", "6m": "6 months", "1y": "year" }
const RANGE_LABEL: Record<TrendRange, string> = { w: "W", m: "M", "6m": "6M", "1y": "1Y" }
const DEFAULT_RANGES: readonly TrendRange[] = ["w", "m", "6m"]
/**
 * A stacked day without a breakdown: its total as a dashed outline, so it never reads as a part, nor as today's
 * faded running total.
 */
const UNSPLIT = "var(--muted-foreground)"
const UNSPLIT_FILL = "color-mix(in srgb, var(--foreground) 4%, transparent)"
const unitText = (unit?: string) => (unit ? (unit === "%" ? "%" : `\u00a0${unit}`) : "")
/** Three ranges sit beside the average; four (Trends) take their own full-width row above it, so the chip never wraps. */
const headerClass = (ranges: readonly TrendRange[]) =>
  cn("mb-4 flex gap-3", ranges.length > 3 ? "flex-col-reverse" : "items-start justify-between")

/** Mean of the values in the `days` days ending at index `i`; null when there are none. */
function trailingMean(points: TrendPoint[], i: number, days: number) {
  const xs = points.slice(Math.max(0, i - days + 1), i + 1).flatMap((x) => (x.value === null ? [] : [x.value]))
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

function colorFor(colorBy: TrendChartProps["colorBy"], v: number) {
  if (colorBy === "band") return DATA_COLORS[recoveryColor(v)].css
  if (colorBy === "stress") return DATA_COLORS[STRESS_COLOR[stressLevel(v)]].css
  if (colorBy === "strain") return DATA_COLORS.strain.css
  if (colorBy === "sleep") return DATA_COLORS.sleep.css
  return DATA_COLORS["chart-5"].css
}

/** The bands a line is coloured by, ascending; null for one-hue metrics. */
function bandsFor(colorBy: TrendChartProps["colorBy"]): Band[] | null {
  if (colorBy === "band") return [0, 34, 67].map((from) => ({ from, color: DATA_COLORS[recoveryColor(from)].css }))
  if (colorBy === "stress") return [0, 1, 2].map((from) => ({ from, color: DATA_COLORS[STRESS_COLOR[stressLevel(from)]].css }))
  return null
}

// Text colours for band ticks on the dark card: red uses the lifted red (spec §2.3).
const BAND_TICK = { green: "var(--recovery-green)", yellow: "var(--recovery-yellow)", red: "var(--recovery-red-text)" } as const

/** A bar that fades from its colour at the top to half at the floor, under a 2 px cap in full colour (WHOOP's Recovery bars). */
function CapBar(props: { x?: number; y?: number; width?: number; height?: number; payload?: { fill?: string; fillOpacity?: number }; gradientOf: (c: string) => string }) {
  const { x = 0, y = 0, width = 0, height = 0, payload, gradientOf } = props
  const c = payload?.fill
  if (!c || height <= 0) return null
  return (
    <g opacity={payload?.fillOpacity ?? 1}>
      <Rectangle x={x} y={y} width={width} height={height} radius={[4, 4, 0, 0]} fill={`url(#${gradientOf(c)})`} />
      <Rectangle x={x} y={y} width={width} height={Math.min(2, height)} radius={[2, 2, 0, 0]} fill={c} />
    </g>
  )
}

function Trend({ points, p }: { points: TrendPoint[]; p: TrendChartProps }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const today = useOptionalShellCalendar()?.today ?? points.at(-1)?.date ?? ""
  const anim = useSeriesAnimation()
  const uid = React.useId().replace(/:/g, "")
  const fallback = p.defaultRange ?? "m"
  const ranges = p.ranges ?? DEFAULT_RANGES
  const parsed = params.get("r") ? parseRange(params.get("r") ?? undefined) : fallback
  const urlRange = ranges.includes(parsed) ? parsed : fallback
  const [range, setRange] = React.useState<TrendRange>(p.fixedRange ?? urlRange)
  const [active, setActive] = React.useState<number | null>(null)
  // Follow `?r=` when it changes elsewhere (another chart, back/forward) without an effect.
  const [lastUrlRange, setLastUrlRange] = React.useState(urlRange)
  if (urlRange !== lastUrlRange) {
    setLastUrlRange(urlRange)
    if (!p.fixedRange) setRange(urlRange)
  }

  const n = RANGE_DAYS[range]
  const rows = points.slice(-n).map((pt, i) => ({
    ...pt,
    fill: pt.value === null ? undefined : colorFor(p.colorBy, pt.value),
    fillOpacity: pt.provisional ? 0.45 : 1,
    text: pt.value === null ? "" : formatValue(p.format, pt.value),
    // Stacked: one key per part, and the total under `unsplit` on a day without a breakdown.
    ...(p.stack && Object.fromEntries(p.stack.map((s) => [`part_${s.key}`, pt.parts?.[s.key] ?? null]))),
    unsplit: p.stack && pt.value !== null && !pt.parts ? pt.value : null,
    // The total over the stack's top bar: on the top part's bar for a split day, on the grey bar for the rest.
    label_top: pt.parts && pt.value !== null ? formatValue(p.format, pt.value) : "",
    label_unsplit: !pt.parts && pt.value !== null ? formatValue(p.format, pt.value) : "",
    smooth: p.smooth ? trailingMean(points, points.length - Math.min(n, points.length) + i, p.smooth) : null,
  }))
  const values = rows.map((r) => r.value).filter((v): v is number => v !== null)
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
  const delta = p.deltas?.[range] ?? null
  const tone = delta === null || !p.direction || delta === 0 ? null : deltaTone(p.direction, delta, 0).tone
  const scrubbed = active !== null ? rows[active] : null
  const byDay = p.headline === "day"
  // The day the header and legend describe: the scrubbed one, else the selected (last) day.
  const shown = scrubbed ?? (byDay || p.stack ? (rows.at(-1) ?? null) : null)
  const line = range === "6m" || range === "1y"
  // A single-hue 6M line (Pulse Age, VO2 max, vitals) fits its data; bars always start at zero.
  const domain: [number | "auto", number | "auto"] =
    p.colorBy === "band" ? [0, 100] : p.colorBy === "stress" ? [0, 3] : line && p.colorBy === "single" ? ["auto", "auto"] : [0, "auto"]
  // Room for the widest tick ("15,000", "5:00"): about 7 px a character at 12 px, the tick margin, and one more
  // character for a rounded-up top tick. Three characters fit the original 32 px.
  const widest = formatValue(p.format, Math.max(0, ...rows.map((r) => r.value ?? 0))).length
  const axisWidth = widest <= 3 ? 32 : 15 + 7 * widest

  const bands = bandsFor(p.colorBy)
  const lo = values.length ? Math.min(...values) : 0
  const hi = values.length ? Math.max(...values) : 0
  // One gradient per bar colour (gradients can't take the referencing bar's colour).
  const barColors: string[] = [...new Set(rows.flatMap((r) => (r.fill ? [r.fill] : [])))]
  const gradientOf = (c: string) => `bar-${uid}-${barColors.indexOf(c)}`
  // Band metrics label their thresholds in band colours; the rest show two ticks above zero, so no bar chart is left without a scale.
  const bandTicks = p.colorBy === "band" ? [33, 67, 100] : p.colorBy === "stress" ? [1, 2, 3] : undefined
  const fmtTick = wholeTick((v) => formatValue(p.format, v))
  const showAvg = !line && range !== "w" && avg !== null
  const gutter = labelGutter([p.reference?.label, showAvg && "Avg"])

  const ticks =
    range === "w"
      ? rows.map((r) => r.date)
      : range === "m"
        ? rows.filter((_, i) => (rows.length - 1 - i) % 7 === 0).map((r) => r.date)
        : rows.filter((r, i) => i > 0 && r.date.slice(0, 7) !== rows[i - 1].date.slice(0, 7)).map((r) => r.date)
  const tickFormat = (d: string) => formatDay(d, range === "w" ? { weekday: "narrow" } : range === "m" ? DAY.monthDay : { month: "short" })

  const partAvg = (key: string) => {
    const xs = rows.map((r) => r.parts?.[key]).filter((v): v is number => v != null)
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
  }
  const summary = values.length
    ? `${p.label} over the last ${RANGE_WORD[range]}: average ${spoken(formatValue(p.format, avg), p.unit)}, range ${formatValue(p.format, Math.min(...values))} to ${formatValue(p.format, Math.max(...values))}${rows.length - values.length ? `, ${rows.length - values.length} ${rows.length - values.length === 1 ? "day" : "days"} missing` : ""}.${
        p.stack ? ` Average split: ${p.stack.map((s) => `${s.label} ${formatValue(p.format, partAvg(s.key))}`).join(", ")}.` : ""
      }`
    : `No ${p.label} data in the last ${RANGE_WORD[range]}.`

  const changeRange = (v: string) => {
    if (!v) return
    setRange(v as TrendRange)
    setActive(null)
    router.replace(`${pathname}${withParam(params.toString(), "r", v === fallback ? null : v)}`, { scroll: false })
  }

  return (
    <div className="min-w-0">
      <div className={headerClass(ranges)}>
        <div className="min-w-0" aria-live="polite">
          <p className="text-xs leading-4 font-bold tracking-[0.1em] text-muted-foreground uppercase tabular-nums">
            {scrubbed || byDay ? dayLabel(shown?.date ?? today, today) : "Average"}
          </p>
          <ValueUnit
            value={formatValue(p.format, scrubbed || byDay ? (shown?.value ?? null) : avg)}
            unit={p.unit}
            className="block font-numeric text-[28px] leading-8 font-bold"
          />
          {p.stack && (
            <StackLegend
              series={p.stack}
              // The header's number: the shown day's split, or the range's average split under "Average".
              point={scrubbed || byDay ? shown : { date: "", value: avg, parts: Object.fromEntries(p.stack.map((x) => [x.key, partAvg(x.key) ?? 0])) }}
              format={p.format}
            />
          )}
          {!scrubbed && !byDay && delta !== null && (
            <StatusChip
              tone={tone === "good" ? "optimal" : tone === "bad" ? "warning" : "neutral"}
              delta={delta > 0 ? "up" : delta < 0 ? "down" : "flat"}
              className="mt-1"
            >
              {formatValue(p.format, Math.abs(delta))}
              {p.unit === "%" ? "%" : p.unit ? `\u00a0${p.unit}` : ""} {RANGE_PRIOR[range]}
            </StatusChip>
          )}
        </div>
        {!p.fixedRange && (
          <ToggleGroup type="single" value={range} onValueChange={changeRange} spacing={0} className={cn("shrink-0 gap-0.5 rounded-lg bg-muted p-0.5", ranges.length > 3 && "w-full")} aria-label="Range">
            {ranges.map((r) => (
              <ToggleGroupItem
                key={r}
                value={r}
                aria-label={RANGE_ARIA[r]}
                className={cn("h-10 min-w-11 rounded-md! px-3 font-numeric text-[13px] font-bold text-muted-foreground transition-[background-color,color] duration-150 ease-standard hover:bg-transparent hover:text-foreground data-[state=on]:bg-secondary data-[state=on]:text-foreground", ranges.length > 3 && "flex-1")}
              >
                {RANGE_LABEL[r]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </div>

      {values.length === 0 ? (
        <div className="grid h-[200px] place-items-center">
          <EmptyState body="No data in this range yet." />
        </div>
      ) : (
        <ChartFigure summary={summary} config={{ value: { label: p.label, color: colorFor(p.colorBy, avg ?? 0) } }} className="h-[200px]">
          <ComposedChart
            data={rows}
            accessibilityLayer
            margin={{ top: range === "w" ? 18 : 8, right: gutter, bottom: 0, left: 4 }}
            onMouseMove={(s) => setActive(s?.activeTooltipIndex == null ? null : Number(s.activeTooltipIndex))}
            onMouseLeave={() => setActive(null)}
          >
            <CartesianGrid {...GRID} />
            <defs>
              {barColors.map((c) => (
                <FadeGradient key={c} id={gradientOf(c)} color={c} from={1} to={0.5} />
              ))}
              {bands && line && <BandGradient id={`line-${uid}`} top={hi} bottom={lo} bands={bands} />}
              <FadeGradient id={`area-${uid}`} color={line && bands ? "var(--foreground)" : colorFor(p.colorBy, avg ?? 0)} from={0.18} />
            </defs>
            <XAxis
              dataKey="date"
              {...AXIS}
              ticks={ticks}
              interval={range === "w" ? 0 : "preserveStartEnd"}
              minTickGap={8}
              // The day the header describes reads bold in the foreground colour (WHOOP's "Wed 17").
              tick={({ x, y, payload }: { x?: number | string; y?: number | string; payload?: { value: string } }) => {
                const on = range === "w" && payload?.value === shown?.date
                return (
                  <text x={x} y={y} dy="0.71em" textAnchor="middle" fontSize={12} fontWeight={on ? 700 : 500} fill={on ? "var(--foreground)" : "var(--muted-foreground)"}>
                    {tickFormat(payload?.value ?? "")}
                  </text>
                )
              }}
            />
            <YAxis
              {...AXIS}
              width={axisWidth}
              tickCount={3}
              ticks={line ? undefined : bandTicks}
              domain={domain}
              tick={({ x, y, payload }: { x?: number | string; y?: number | string; payload?: { value: number } }) => {
                const v = Number(payload?.value)
                // Zero is the floor every bar stands on; a label there only crowds the first day's tick.
                if (!line && v === 0) return <g />
                const fill = p.colorBy === "band" && !line ? BAND_TICK[recoveryBand(v)] : "var(--muted-foreground)"
                return (
                  <text x={x} y={y} dy="0.32em" textAnchor="end" fontSize={12} fontWeight={p.colorBy === "band" && !line ? 600 : 500} fill={fill}>
                    {fmtTick(v)}
                  </text>
                )
              }}
            />
            {p.baseline && (
              <ReferenceArea y1={p.baseline.mean - p.baseline.sd} y2={p.baseline.mean + p.baseline.sd} fill="var(--chart-band)" fillOpacity={1} ifOverflow="extendDomain" />
            )}
            {p.reference && (
              <ReferenceLine
                y={p.reference.y}
                stroke="var(--chart-cursor)"
                strokeDasharray="4 4"
                ifOverflow="extendDomain"
                label={gutterLabel(p.reference.label, "var(--muted-foreground)")}
              />
            )}
            {/* the reference app's month bars carry a dashed average line [latest-trends-1] (spec §11 F21). */}
            {showAvg && (
              <ReferenceLine y={avg} stroke="var(--chart-cursor)" strokeDasharray="3 3" label={gutterLabel("Avg")} />
            )}
            {p.target && <ReferenceArea y1={p.target[0]} y2={p.target[1]} fill="var(--dial-target)" fillOpacity={0.3} ifOverflow="extendDomain" />}
            <ChartTooltip
              isAnimationActive={false}
              cursor={line ? LINE_CURSOR : BAR_CURSOR}
              content={
                <ChartTooltipContent
                  className={TOOLTIP_CLASS}
                  indicator="line"
                  hideIndicator
                  labelFormatter={(_, payload) => dayLabel(String(payload?.[0]?.payload?.date ?? ""), today)}
                  formatter={(_, __, item, index) => {
                    const row = item.payload as (typeof rows)[number]
                    // Stacked bars hand the formatter one item per drawn part; the day's lines are written once.
                    if (index > 0) return null
                    return (
                      <div className="grid gap-1">
                        {p.stack &&
                          row.parts &&
                          [...p.stack].reverse().map((s) => (
                            <TooltipLine key={s.key} color={s.color}>
                              {s.label} {formatValue(p.format, row.parts?.[s.key])}
                              {unitText(p.unit)}
                            </TooltipLine>
                          ))}
                        <TooltipLine color={p.stack ? (row.parts ? undefined : UNSPLIT) : row.fill}>
                          {p.stack && "Total "}
                          {row.text}
                          {unitText(p.unit)}
                        </TooltipLine>
                        {p.stack && !row.parts && <span className="text-muted-foreground">No breakdown</span>}
                        {row.provisional && <span className="text-muted-foreground">{p.stack ? "So far" : "Provisional"}</span>}
                      </div>
                    )
                  }}
                />
              }
            />
            {line && (
              <Area dataKey="value" type="monotone" stroke="none" fill={`url(#area-${uid})`} connectNulls={false} activeDot={false} tooltipType="none" {...anim} />
            )}
            {line ? (
              <Line
                dataKey="value"
                type="monotone"
                // Band metrics colour the line by the band it passes through (Bevel's Strain trend); one-hue metrics keep it quiet.
                stroke={bands ? bandPaint(`line-${uid}`, hi, lo, bands) : "var(--foreground-secondary)"}
                strokeWidth={bands ? 2 : 1.5}
                connectNulls={false}
                dot={(d: { cx?: number; cy?: number; index?: number; payload?: (typeof rows)[number] }) =>
                  d.payload?.value == null || d.cx == null || d.cy == null ? (
                    <g key={d.index} />
                  ) : (
                    <circle key={d.index} cx={d.cx} cy={d.cy} r={d.index === rows.length - 1 ? 4 : 2.5} fill={d.payload.fill} fillOpacity={d.payload.fillOpacity} stroke={d.index === rows.length - 1 ? "var(--card)" : "none"} strokeWidth={2} />
                  )
                }
                activeDot={(d: { cx?: number; cy?: number; payload?: (typeof rows)[number] }) => <GlowDot cx={d.cx} cy={d.cy} fill={d.payload?.fill} />}
                {...anim}
              />
            ) : p.stack ? (
              [
                ...p.stack.map((s, i) => ({ ...s, dataKey: `part_${s.key}`, label: i === p.stack!.length - 1 ? "label_top" : null })),
                { key: "unsplit", dataKey: "unsplit", color: UNSPLIT_FILL, label: "label_unsplit", outline: true },
              ].map((s) => (
                <Bar key={s.key} dataKey={s.dataKey} stackId="day" fill={s.color} radius={s.label ? [3, 3, 0, 0] : 0} maxBarSize={28} {...anim}>
                  {rows.map((r) => (
                    <Cell
                      key={r.date}
                      fill={s.color}
                      fillOpacity={r.fillOpacity}
                      {...("outline" in s && { stroke: UNSPLIT, strokeDasharray: "3 2", strokeOpacity: r.fillOpacity })}
                    />
                  ))}
                  {range === "w" && s.label && <LabelList dataKey={s.label} position="top" fill="var(--foreground)" fontSize={11} />}
                </Bar>
              ))
            ) : (
              <Bar dataKey="value" maxBarSize={28} shape={(b: object) => <CapBar {...b} gradientOf={gradientOf} />} {...anim}>
                {range === "w" && <LabelList dataKey="text" position="top" fill="var(--foreground)" fontSize={11} />}
              </Bar>
            )}
            {p.smooth && <Line dataKey="smooth" type="monotone" stroke="var(--foreground)" strokeWidth={2} dot={false} activeDot={false} connectNulls {...anim} />}
          </ComposedChart>
        </ChartFigure>
      )}
      {(p.baseline || p.target || p.smooth) && values.length > 0 && (
        <p className={cn("mt-2 text-xs leading-4 font-medium text-muted-foreground")}>
          {p.target ? "Shaded: your Strain Target" : p.baseline ? "Shaded: your normal range" : `Line: ${p.smooth}-day average`}
        </p>
      )}
    </div>
  )
}

/** The shown day's parts beside their swatches, top part first (the bars' order); a day without parts says so. */
function StackLegend({ series, point, format }: { series: readonly TrendSeries[]; point: TrendPoint | null; format: FormatKey }) {
  const parts = point?.parts
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs leading-4 font-medium text-muted-foreground">
      {point?.value != null && !parts ? (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-[2px] border border-dashed" style={{ borderColor: UNSPLIT }} />
          No breakdown for this day
        </span>
      ) : (
        [...series].reverse().map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-[2px]" style={{ background: s.color }} />
            {s.label}
            <span className="font-numeric font-semibold text-foreground-secondary tabular-nums">{formatValue(format, parts?.[s.key])}</span>
          </span>
        ))
      )}
    </p>
  )
}

/** One metric over W, M or 6M (spec §5.5). The range lives in `?r=` (default `m`). */
export function TrendChart(p: TrendChartProps) {
  return (
    <MetricState metric={p.data} skeleton={<TrendChartSkeleton ranges={p.ranges} day={p.headline === "day"} legend={!!p.stack} />} empty={<EmptyState body="No data in this range yet." />}>
      {(points) => (
        <React.Suspense fallback={<TrendChartSkeleton ranges={p.ranges} day={p.headline === "day"} legend={!!p.stack} />}>
          <Trend points={points} p={p} />
        </React.Suspense>
      )}
    </MetricState>
  )
}

/**
 * `chip`: room for the change-vs-prior chip under the average, which charts with a prior period show.
 * `caption`: the baseline / target line under the plot. `ranges`: the toggle's ranges, as on the chart.
 * `day`: the header names a day (`headline="day"`), so its label is a bar too. `legend`: a stacked chart's split line.
 */
export function TrendChartSkeleton({
  chip = false,
  caption = false,
  ranges = DEFAULT_RANGES,
  day = false,
  legend = false,
}: { chip?: boolean; caption?: boolean; ranges?: readonly TrendRange[]; day?: boolean; legend?: boolean } = {}) {
  // The header's real label and a disabled range toggle; bars for the numbers; the plot at its fixed height (spec §5.19).
  return (
    <div aria-hidden className="min-w-0">
      <div className={headerClass(ranges)}>
        <div className="min-w-0">
          {day ? (
            <SkeletonText className="w-[6ch] text-xs leading-4" />
          ) : (
            <p className="text-xs leading-4 font-bold tracking-[0.1em] text-muted-foreground uppercase">Average</p>
          )}
          <SkeletonText className="w-[4ch] font-numeric text-[28px] leading-8 font-bold" />
          {legend && <SkeletonText className="mt-1.5 w-40 text-xs leading-4" />}
          {chip && <Skeleton className="mt-1 h-6 w-28 rounded-md" />}
        </div>
        <div className={cn("flex shrink-0 gap-0.5 rounded-lg bg-muted p-0.5", ranges.length > 3 && "w-full")}>
          {ranges.map((r) => (
            <span key={r} className={cn("grid h-10 min-w-11 place-items-center rounded-md px-3 font-numeric text-[13px] font-bold text-muted-foreground/60", ranges.length > 3 && "flex-1")}>
              {RANGE_LABEL[r]}
            </span>
          ))}
        </div>
      </div>
      <Skeleton className="h-[200px] rounded-lg bg-muted/60" />
      {caption && <SkeletonText className="mt-2 w-48 text-xs leading-4" />}
    </div>
  )
}
TrendChart.Skeleton = TrendChartSkeleton
