"use client"

import * as React from "react"
import { useSheetParam } from "@/hooks/use-sheet-param"
import { Activity, Droplet, Heart, Thermometer, Wind } from "lucide-react"
import { formatValue, isSymbolUnit, NBSP, type FormatKey } from "@/lib/format"
import type { Vital, VitalKey } from "@/server/queries/types"
import { TrendChart } from "@/components/charts/TrendChart"
import { KeyStatRow, KeyStatRowSkeleton } from "@/components/metrics/KeyStatRow"
import { StatusChip, ValueUnit } from "@/components/metrics/primitives"
import { ResponsiveSheet } from "@/components/shells/ResponsiveSheet"

const ICON: Record<VitalKey, React.ReactNode> = {
  resp: <Wind />,
  spo2: <Droplet />,
  restingHr: <Heart />,
  hrv: <Activity />,
  skinTempDev: <Thermometer />,
}
const FORMAT: Record<VitalKey, FormatKey> = { resp: "decimal1", spo2: "int", restingHr: "int", hrv: "int", skinTempDev: "signed1" }
/**
 * Five tiles: two a row below laptop, the fifth a full-width strip with its 30-night sparkline; five a row on laptop.
 * Tablet once ran a 3 + 2 six-column grid whose two stretched tiles were half empty.
 */
const GRID = "grid grid-cols-2 gap-3 *:last:col-span-2 xl:grid-cols-5 xl:gap-4 xl:*:last:col-span-1"
const NOTE = "Resting heart rate, HRV and skin temperature use Google’s personal ranges when it has them; otherwise your range is your baseline ± 2 SD over 60 nights."

/** The five vital tiles, each opening its vital sheet (journey 6), plus the ranges note cell. */
export function VitalTiles({ vitals }: { vitals: Vital[] }) {
  // `?vital=hrv` deep-links the sheet; Back closes it.
  const [open, setOpen] = useSheetParam("vital")
  const [last, setLast] = React.useState<Vital | null>(null)
  const current = vitals.find((x) => x.key === open)
  const v = current ?? last
  const fmt = v ? FORMAT[v.key] : "int"
  // Ranges always show one decimal, as the chips do, so a whole-number reading never looks equal to its bound.
  const rangeFmt = v?.key === "skinTempDev" ? "signed1" : "decimal1"
  const unit = (u: string) => (isSymbolUnit(u) ? u : `${NBSP}${u}`)

  return (
    <>
      <div className={GRID}>
        {vitals.map((x, i) => (
          <KeyStatRow
            key={x.key}
            variant="tile"
            // The fifth tile spans the row below laptop (GRID): a wide strip with its range on the right.
            wide={i === vitals.length - 1 && "xl"}
            // Its last 30 nights with the normal range shaded fill the strip's spare width.
            spark={{ values: x.trend.points.slice(-30).map((p) => p.value), band: x.range, caption: "Last 30 nights" }}
            icon={ICON[x.key]}
            // the reference app's tiles abbreviate the two heart metrics ("RHR", "HRV") [latest-health-monitor-1]; the sheet keeps the full name.
            label={x.key === "restingHr" || x.key === "hrv" ? x.short : x.label}
            metric={x.metric}
            unit={x.unit}
            format={FORMAT[x.key]}
            direction="none"
            chip={x.chip ?? undefined}
            onSelect={() => {
              setOpen(x.key)
              setLast(x)
            }}
          />
        ))}
      </div>
      <p className="mt-3 text-xs leading-4 font-medium text-pretty text-muted-foreground">{NOTE}</p>

      <ResponsiveSheet open={!!current} onOpenChange={(o) => !o && setOpen(null)} title={v?.label ?? "Vital"}>
        {v && (
          <div className="space-y-4">
            <div className="space-y-2">
              <ValueUnit value={formatValue(fmt, v.metric.value)} unit={v.unit} className="block font-numeric text-4xl leading-10 font-bold tracking-[-0.01em]" />
              {v.chip && v.metric.value !== null && <StatusChip tone={v.chip.tone}>{v.chip.text}</StatusChip>}
            </div>
            {v.range && (
              <p className="text-[15px] leading-[22px] text-foreground-secondary tabular-nums">
                Your normal range: {formatValue(rangeFmt, v.range.low)} - {v.key === "spo2" ? 100 : formatValue(rangeFmt, v.range.high)}
                {unit(v.unit)}
              </p>
            )}
            <TrendChart
              label={v.label}
              data={{ value: v.trend.points.map((p) => ({ date: p.day, value: p.value })), reason: null, provisional: false }}
              unit={v.unit}
              format={fmt}
              colorBy="single"
              fixedRange="6m"
              baseline={v.trend.baseline}
            />
          </div>
        )}
      </ResponsiveSheet>
    </>
  )
}

const SKELETON_LABEL: [VitalKey, string][] = [
  ["resp", "Respiratory rate"],
  ["spo2", "Blood oxygen"],
  ["restingHr", "RHR"],
  ["hrv", "HRV"],
  ["skinTempDev", "Skin temp (from baseline)"],
]

/** Loading shape (spec §5.19): the same grid of five tiles and the note, with bars for the readings. */
export function VitalTilesSkeleton() {
  return (
    <>
      <div className={GRID}>
        {SKELETON_LABEL.map(([k, l]) => (
          <KeyStatRowSkeleton key={k} variant="tile" label={l} icon={ICON[k]} />
        ))}
      </div>
      <p className="mt-3 text-xs leading-4 font-medium text-pretty text-muted-foreground">{NOTE}</p>
    </>
  )
}
