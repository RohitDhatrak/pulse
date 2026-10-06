"use client"

import { Area, Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts"
import { DAY, formatDay, formatValue } from "@/lib/format"
import type { FitnessVM } from "@/server/queries/types"
import { ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { AXIS, ChartFigure, FadeGradient, GRID, LINE_CURSOR, TOOLTIP_CLASS, useSeriesAnimation } from "@/components/charts/ChartFrame"

const CONFIG = {
  ctl: { label: "Fitness", color: "var(--chart-1)" },
  atl: { label: "Fatigue", color: "var(--chart-4)" },
  tsb: { label: "Form", color: "var(--chart-2)" },
}

/** Fitness (CTL), fatigue (ATL) and form (TSB) over 90 days (spec §7.10). */
export function LoadChart({ load }: { load: FitnessVM["load"] }) {
  const anim = useSeriesAnimation()
  const last = [...load].reverse().find((p) => p.ctl !== null)
  const summary = last
    ? `Training load over 90 days: fitness ${formatValue("int", last.ctl)}, fatigue ${formatValue("int", last.atl)}, form ${formatValue("signedInt", last.tsb)} today.`
    : "No training load data yet."
  const ticks = load.filter((p, i) => i > 0 && p.day.slice(0, 7) !== load[i - 1].day.slice(0, 7)).map((p) => p.day)

  return (
    <div>
      <ChartFigure summary={summary} config={CONFIG} className="h-[220px]">
        <ComposedChart data={load} accessibilityLayer margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
          <defs>
            <FadeGradient id="load-ctl" color="var(--chart-1)" from={0.22} />
          </defs>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="day" {...AXIS} ticks={ticks} tickFormatter={(d: string) => formatDay(d, { month: "short" })} />
          <YAxis {...AXIS} width={32} tickCount={4} tickFormatter={(v: number) => formatValue("int", v)} />
          <ReferenceLine y={0} stroke="var(--chart-cursor)" />
          <ChartTooltip
            cursor={LINE_CURSOR}
            content={
              <ChartTooltipContent
                className={TOOLTIP_CLASS}
                indicator="line"
                labelFormatter={(_, p) => formatDay(String(p?.[0]?.payload?.day ?? ""), DAY.short)}
                formatter={(v, name) => (
                  <span className="flex w-full justify-between gap-3">
                    <span className="text-muted-foreground">{CONFIG[name as keyof typeof CONFIG]?.label}</span>
                    <span className="tabular-nums">{formatValue(name === "tsb" ? "signedInt" : "int", Number(v))}</span>
                  </span>
                )}
              />
            }
          />
          <Bar dataKey="tsb" fill="var(--color-tsb)" maxBarSize={4} {...anim}>
            {load.map((p) => (
              <Cell key={p.day} fill={(p.tsb ?? 0) < 0 ? "var(--warning)" : "var(--chart-2)"} fillOpacity={0.6} />
            ))}
          </Bar>
          <Area dataKey="ctl" type="monotone" stroke="none" fill="url(#load-ctl)" connectNulls={false} activeDot={false} tooltipType="none" {...anim} />
          <Line dataKey="ctl" type="monotone" stroke="var(--color-ctl)" strokeWidth={2} dot={false} connectNulls={false} {...anim} />
          <Line dataKey="atl" type="monotone" stroke="var(--color-atl)" strokeWidth={1.5} dot={false} connectNulls={false} {...anim} />
        </ComposedChart>
      </ChartFigure>
      {/* Each series' mark as drawn (two lines, then the bars) with today's value, in the plot's order. */}
      {last && (
        <ul aria-hidden className="mt-3 flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs leading-4 font-medium text-muted-foreground">
          {(
            [
              ["ctl", <span key="m" className="h-0.5 w-3.5 rounded-full bg-chart-1" />, formatValue("int", last.ctl)],
              ["atl", <span key="m" className="h-0.5 w-3.5 rounded-full bg-chart-4" />, formatValue("int", last.atl)],
              ["tsb", <span key="m" className="h-2.5 w-1 rounded-[1px] bg-chart-2" />, formatValue("signedInt", last.tsb)],
            ] as const
          ).map(([k, mark, v]) => (
            <li key={k} className="inline-flex items-center gap-1.5">
              {mark}
              {CONFIG[k].label}
              <span className="font-numeric font-semibold text-foreground-secondary tabular-nums">{v}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
