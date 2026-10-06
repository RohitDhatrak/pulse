"use client"

import { Bar, CartesianGrid, ComposedChart, LabelList, Line, XAxis, YAxis } from "recharts"
import { recoveryBand } from "@/lib/bands"
import { DAY, formatDay, formatValue } from "@/lib/format"
import { ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { AXIS, ChartFigure, GRID, TOOLTIP_CLASS, TooltipLine, useSeriesAnimation } from "./ChartFrame"

export type StrainRecoveryPoint = { day: string; strain: number | null; recovery: number | null }

// Text colours on the dark card: red labels use the lifted red (spec §2.3 ◆).
const BAND_TEXT = { green: "var(--recovery-green)", yellow: "var(--recovery-yellow)", red: "var(--recovery-red-text)" } as const
const BAND_FILL = { green: "var(--recovery-green)", yellow: "var(--recovery-yellow)", red: "var(--recovery-red)" } as const
const RIGHT_TICKS = [0, 33, 66, 100]
const LEFT_TICKS = [0, 7, 14, 21]
/**
 * How far today's lit column runs below the plot, behind the 40 px two-line day tick, with room under the date.
 * The bottom margin keeps it inside the svg: at 0 the svg clipped its last 4 px, square corners and all.
 */
const TODAY_TAIL = 48

type Row = StrainRecoveryPoint & { weekday: string; dayOfMonth: string; date: string; today: boolean; hl: number | null }

type TickProps = { x?: number; y?: number; payload?: { value: string | number; index?: number }; rows?: Row[] }
type LabelProps = { x?: number | string; y?: number | string; value?: unknown; index?: number; rows?: Row[] }

/** Two-line day tick ("Fri" over "17"); today in white and bold. */
function XTick({ x = 0, y = 0, payload, rows = [] }: TickProps) {
  const row = rows[payload?.index ?? 0]
  if (!row) return null
  return (
    <text x={x} y={y + 4} textAnchor="middle" fontSize={12} fill={row.today ? "var(--foreground)" : "var(--muted-foreground)"} fontWeight={row.today ? 700 : 500}>
      <tspan x={x} dy="0.71em">
        {row.weekday}
      </tspan>
      <tspan x={x} dy="1.35em">
        {row.dayOfMonth}
      </tspan>
    </text>
  )
}

/** Right-axis percentages in their band colours (0 and 33 red, 66 yellow, 100 green). */
function RightTick({ x = 0, y = 0, payload }: TickProps) {
  const v = Number(payload?.value)
  return (
    <text x={x} y={y} dy="0.32em" fontSize={12} fontWeight={600} fill={BAND_TEXT[recoveryBand(v)]}>
      {v}%
    </text>
  )
}

function RecoveryDot({ cx, cy, payload }: { cx?: number; cy?: number; payload?: Row }) {
  if (cx == null || cy == null || payload?.recovery == null) return null
  return <circle cx={cx} cy={cy} r={4} fill="var(--card)" stroke={BAND_FILL[recoveryBand(payload.recovery)]} strokeWidth={2} />
}

/** Height on the plot, 0 (floor) to 1 (top), so the two axes compare. */
const heightOf = (r: Row | undefined, k: "strain" | "recovery") => (r?.[k] == null ? null : k === "strain" ? r.strain! / 21 : r.recovery! / 100)

/**
 * Each label sits on the side away from the other series' dot that day: the higher dot's label above it, the lower
 * one's under it (above it near the floor, so it never sits on the day ticks). With one series missing, Recovery's
 * label goes above and Strain's under, as the reference app draws them.
 */
function labelDy(rows: Row[], index: number | undefined, k: "strain" | "recovery") {
  const r = rows[index ?? -1]
  const self = heightOf(r, k)
  const other = heightOf(r, k === "strain" ? "recovery" : "strain")
  const above = other === null ? k === "recovery" : self !== null && self >= other
  return above || (self ?? 0) < 0.17 ? -10 : 20
}

function RecoveryLabel({ x, y, value, index, rows = [] }: LabelProps) {
  if (typeof value !== "number" || x == null || y == null) return null
  return (
    <text x={Number(x)} y={Number(y) + labelDy(rows, index, "recovery")} textAnchor="middle" fontSize={12} fontWeight={700} fill={BAND_TEXT[recoveryBand(value)]}>
      {Math.round(value)}%
    </text>
  )
}

function StrainLabel({ x, y, value, index, rows = [] }: LabelProps) {
  if (typeof value !== "number" || x == null || y == null) return null
  return (
    <text x={Number(x)} y={Number(y) + labelDy(rows, index, "strain")} textAnchor="middle" fontSize={12} fontWeight={700} fill="var(--strain-text)">
      {formatValue("decimal1", value)}
    </text>
  )
}

/**
 * the reference app's Home "Strain & Recovery" week [latest-home-collapsed-2]: Strain on the left axis (0-21, blue),
 * Recovery on the right (0-100 %, band colours), hollow dots with value labels, today's column lit.
 * Missing days are gaps, never interpolated.
 */
export function StrainRecoveryChart({ points, today, grow }: { points: StrainRecoveryPoint[]; today: string; grow?: boolean }) {
  const anim = useSeriesAnimation()
  const rows: Row[] = points.map((p) => ({
    ...p,
    weekday: formatDay(p.day, { weekday: "short" }),
    dayOfMonth: formatDay(p.day, { day: "numeric" }),
    date: formatDay(p.day, DAY.short),
    today: p.day === today,
    hl: p.day === today ? 100 : null,
  }))
  const strains = points.map((p) => p.strain).filter((v): v is number => v !== null)
  const recs = points.map((p) => p.recovery).filter((v): v is number => v !== null)
  const summary = `Strain and Recovery over the last ${points.length} days: Strain ${
    strains.length ? `from ${formatValue("decimal1", Math.min(...strains))} to ${formatValue("decimal1", Math.max(...strains))}` : "not recorded"
  }, Recovery ${recs.length ? `from ${Math.round(Math.min(...recs))} to ${Math.round(Math.max(...recs))} percent` : "not recorded"}.`

  return (
    <ChartFigure summary={summary} config={{ strain: { label: "Strain" }, recovery: { label: "Recovery" } }} className={grow ? "h-[232px] xl:h-auto xl:min-h-[232px]" : "h-[232px]"} grow={grow}>
      <ComposedChart data={rows} accessibilityLayer margin={{ top: 20, right: 4, bottom: TODAY_TAIL - 40 + 2, left: 4 }} barCategoryGap="18%">
        <CartesianGrid {...GRID} yAxisId="s" />
        <XAxis dataKey="day" interval={0} height={40} tick={<XTick rows={rows} />} {...AXIS} tickMargin={4} />
        <YAxis yAxisId="s" domain={[0, 21]} ticks={LEFT_TICKS} width={24} tick={{ fill: "var(--strain-text)", fontSize: 12, fontWeight: 600 }} {...AXIS} />
        <YAxis yAxisId="r" orientation="right" domain={[0, 100]} ticks={RIGHT_TICKS} width={40} tick={<RightTick />} {...AXIS} />
        {/* Today's column: a light band behind both series, as the reference app lights the current day. */}
        {/* It runs down behind the day ticks too, so "Sat 3" sits inside the lit column as in the reference app [latest-home-collapsed-3] (spec §11 F9). */}
        <Bar
          yAxisId="r"
          dataKey="hl"
          fill="color-mix(in srgb, var(--foreground) 6%, transparent)"
          isAnimationActive={false}
          tooltipType="none"
          shape={(b: { x?: number; y?: number; width?: number; height?: number }) =>
            b.height ? <rect x={b.x} y={b.y} width={b.width} height={b.height + TODAY_TAIL} rx={6} fill="color-mix(in srgb, var(--foreground) 6%, transparent)" /> : <g />
          }
        />
        <ChartTooltip
          isAnimationActive={false}
          cursor={{ fill: "color-mix(in srgb, var(--foreground) 4%, transparent)" }}
          allowEscapeViewBox={{ x: false, y: false }}
          wrapperStyle={{ pointerEvents: "none" }}
          content={
            <ChartTooltipContent
              className={TOOLTIP_CLASS}
              hideIndicator
              labelFormatter={(_, payload) => (payload?.[0]?.payload as Row | undefined)?.date ?? ""}
              formatter={(value, name) => {
                if (name === "hl" || value == null) return null
                return name === "strain" ? (
                  <TooltipLine color="var(--strain)">Strain {formatValue("decimal1", Number(value))}</TooltipLine>
                ) : (
                  <TooltipLine color={BAND_FILL[recoveryBand(Number(value))]}>Recovery {Math.round(Number(value))}%</TooltipLine>
                )
              }}
            />
          }
        />
        <Line
          yAxisId="r"
          dataKey="recovery"
          type="linear"
          stroke="var(--foreground-secondary)"
          strokeOpacity={0.35}
          strokeWidth={1.5}
          connectNulls={false}
          dot={(props: { cx?: number; cy?: number; payload?: Row; index?: number }) => <RecoveryDot key={props.index} {...props} />}
          activeDot={false}
          {...anim}
        >
          <LabelList dataKey="recovery" content={<RecoveryLabel rows={rows} />} />
        </Line>
        <Line
          yAxisId="s"
          dataKey="strain"
          type="linear"
          stroke="var(--strain)"
          strokeWidth={2}
          connectNulls={false}
          dot={{ r: 4, fill: "var(--card)", stroke: "var(--strain)", strokeWidth: 2 }}
          activeDot={{ r: 5, fill: "var(--strain)", stroke: "var(--card)", strokeWidth: 2 }}
          {...anim}
        >
          <LabelList dataKey="strain" content={<StrainLabel rows={rows} />} />
        </Line>
      </ComposedChart>
    </ChartFigure>
  )
}

export function StrainRecoveryChartSkeleton() {
  return <Skeleton aria-hidden className="h-[232px] rounded-lg bg-muted/60" />
}
StrainRecoveryChart.Skeleton = StrainRecoveryChartSkeleton
