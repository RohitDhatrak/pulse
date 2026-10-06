"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { DATA_COLORS, deltaTone, GOOD_DIRECTION } from "@/lib/bands"
import { durationWords, hmm, statSentence } from "@/lib/format"
import type { Metric } from "@/lib/reasons"
import { Skeleton, SkeletonText } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/shells/EmptyState"
import { MetricState } from "@/components/shells/MetricState"
import { HypnogramChart, HypnogramSkeleton } from "@/components/charts/Hypnogram"
import { SleepHrChart, SleepHrChartSkeleton, type SleepHr } from "@/components/charts/SleepHrChart"
import { ReasonPlaceholder } from "./ReasonPlaceholder"
import { CAPTION, DeltaMark, LABEL } from "./primitives"

type Stage = "awake" | "rem" | "light" | "deep"
export type SleepStagesNight = {
  bed: number
  wake: number
  segments: { stage: Stage; start: number; end: number }[]
  rows: { stage: Stage; label: string; pct: number; minutes: number; typical: [number, number] }[]
}
/** Time asleep in the main sleep and the prior 30 nights' mean, minutes. */
export type SleepHours = { asleepMin: number; average: number | null; sd?: number }

export type SleepStagesProps = {
  /** The hero: no value means no night, and the whole card shows the reason. */
  hours: Metric<SleepHours> | undefined
  hr: Metric<SleepHr> | undefined
  /** null: a night Fitbit did not stage. */
  data: Metric<SleepStagesNight> | null | undefined
}

// the reference app's order, top to bottom [latest-sleep-stages-1].
const ORDER: Stage[] = ["awake", "light", "deep", "rem"]
const EMPTY = "No stage data for this night. Fitbit only stages sleeps longer than about 3 hours."
const HERO = "font-numeric text-[32px] leading-9 font-bold tracking-[-0.01em]"

/** the reference app's "Hours of sleep" [latest-sleep-stages-1]: time asleep, the arrow against the prior 30 nights and their mean under it. */
function HoursHero({ h }: { h: SleepHours }) {
  const t = h.average === null ? undefined : deltaTone(GOOD_DIRECTION.hours, h.asleepMin, h.average, h.sd)
  const sentence = statSentence({
    label: "Hours of sleep",
    valueText: durationWords(h.asleepMin),
    averageText: h.average === null ? undefined : durationWords(h.average),
    dir: t?.dir,
    tone: t?.tone,
  })
  return (
    <div>
      <p className={cn(LABEL, "text-foreground-secondary")}>Hours of sleep</p>
      <p className="sr-only">{sentence}</p>
      <div aria-hidden className="mt-1.5 grid w-fit grid-cols-[auto_8px] items-center gap-x-2">
        <span className={cn(HERO, "tabular-nums")}>{hmm(h.asleepMin)}</span>
        {t ? <DeltaMark dir={t.dir} tone={t.tone} /> : <span />}
        {h.average !== null && <span className="font-numeric text-[13px] leading-4 font-medium text-muted-foreground tabular-nums">{hmm(h.average)}</span>}
      </div>
    </div>
  )
}

function Rows({ night, selected, onSelect }: { night: SleepStagesNight; selected: Stage; onSelect: (s: Stage) => void }) {
  const name = React.useId()
  const span = Math.max(1, night.wake - night.bed)
  const rows = ORDER.map((s) => night.rows.find((r) => r.stage === s)).filter((r) => !!r)

  return (
    <div className="space-y-4">
      {/* Bed and wake times sit on the heart-rate chart's axis above, as in the reference app. */}
      <div className={cn(CAPTION, "flex items-baseline justify-between gap-2 tabular-nums")}>
        <h3 className={cn(LABEL, "text-foreground-secondary")}>Stages</h3>
        <span className="flex items-baseline gap-2">
          <span className={cn(LABEL, "text-muted-foreground")}>Duration</span>
          <span className="font-numeric text-[17px] leading-5 font-bold text-foreground">{hmm(span / 60_000)}</span>
        </span>
      </div>
      {/* The whole night at a glance (a community request): when you were awake, in REM, light or deep sleep. The
          rows below break each stage out and light it on the heart-rate line. */}
      <HypnogramChart night={night} />
      <div role="radiogroup" aria-label="Highlight a sleep stage" className="space-y-4 pt-1">
        {rows.map((r) => {
          const on = r.stage === selected
          const blocks = night.segments.filter((g) => g.stage === r.stage)
          return (
            <label key={r.stage} className="group block cursor-pointer space-y-2.5">
              <span className="flex items-center gap-3">
                <input
                  type="radio"
                  name={name}
                  value={r.stage}
                  checked={on}
                  onChange={() => onSelect(r.stage)}
                  aria-label={`${r.label}, ${Math.round(r.pct)} percent, ${hmm(r.minutes)}. Typical ${r.typical[0]} to ${r.typical[1]} percent`}
                  className="peer sr-only"
                />
                {/* the reference app's radio: a white ring, filled white with a dark centre when chosen. */}
                <span
                  aria-hidden
                  className={cn(
                    "grid size-[22px] shrink-0 place-items-center rounded-full ring-2 transition-[background-color,box-shadow] duration-150 ease-standard ring-inset peer-focus-visible:outline-3 peer-focus-visible:outline-ring/50",
                    on ? "bg-foreground ring-foreground" : "ring-foreground/80 group-hover:ring-foreground"
                  )}
                >
                  {on && <span className="size-2 rounded-full bg-background" />}
                </span>
                <span aria-hidden className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className={LABEL}>{r.label}</span>
                  <span className="font-numeric text-[13px] leading-4 font-semibold text-foreground-secondary tabular-nums">{Math.round(r.pct)}%</span>
                  <span className={cn(CAPTION, "tabular-nums")}>
                    Typical {r.typical[0]}-{r.typical[1]}%
                  </span>
                </span>
                <span aria-hidden className="font-numeric text-xl leading-6 font-bold tabular-nums">
                  {hmm(r.minutes)}
                </span>
              </span>
              {/* The stage's time drawn as blocks on the hatched night track (spec §2.9, V8). */}
              <span aria-hidden className="relative block h-3 overflow-hidden rounded-full bg-(image:--pattern-hatch)">
                {blocks.map((g) => (
                  <span
                    key={g.start}
                    className={cn(
                      "absolute inset-y-0 min-w-0.5 rounded-[2px] transition-opacity duration-150 ease-standard",
                      !on && "opacity-35"
                    )}
                    // In the stage's own colour, as on the hypnogram above, so a row reads as that lane.
                    style={{ background: DATA_COLORS[`stage-${r.stage}`].css, left: `${((g.start - night.bed) / span) * 100}%`, width: `${((g.end - g.start) / span) * 100}%` }}
                  />
                ))}
              </span>
            </label>
          )
        })}
      </div>
    </div>
  )
}

/**
 * the reference app's "Last night's sleep" card (spec §7.5, §11 V8, R9): the hours hero, the overnight heart rate, then the stage
 * rows with hatched tracks. Choosing a stage lights its blocks on the tracks and its stretches on the heart-rate line.
 */
export function SleepStages({ hours, hr, data }: SleepStagesProps) {
  const [selected, setSelected] = React.useState<Stage>("awake")
  const segments = data?.value?.segments
  const highlight = React.useMemo(() => (segments?.length ? segments.filter((g) => g.stage === selected) : undefined), [segments, selected])
  return (
    <MetricState
      metric={hours}
      skeleton={<SleepStagesSkeleton />}
      renderReason={(r, meta) => (
        <div className="grid place-items-center">
          <ReasonPlaceholder reason={r} nightsLeft={meta.nightsLeft} size="md" />
        </div>
      )}
    >
      {(h) => (
        <div className="space-y-4">
          <HoursHero h={h} />
          <SleepHrChart data={hr} highlight={highlight} />
          <div className="border-t border-border pt-4">
            <MetricState
              metric={data}
              skeleton={<StageRowsSkeleton />}
              empty={<EmptyState body={EMPTY} />}
              renderReason={(r) => <ReasonPlaceholder reason={r} size="md" />}
            >
              {(night) => (night.segments.length ? <Rows night={night} selected={selected} onSelect={setSelected} /> : <EmptyState body={EMPTY} />)}
            </MetricState>
          </div>
        </div>
      )}
    </MetricState>
  )
}

function StageRowsSkeleton() {
  return (
    <div aria-hidden className="space-y-4">
      <div className="flex items-baseline justify-between">
        <span className={cn(LABEL, "text-foreground-secondary")}>Stages</span>
        <SkeletonText className="w-24 text-[17px] leading-5" />
      </div>
      <HypnogramSkeleton />
      {["Awake", "Light", "Deep", "REM"].map((l) => (
        <div key={l} className="space-y-2.5">
          <div className="flex items-center gap-3">
            <span className="size-[22px] rounded-full ring-2 ring-foreground/30 ring-inset" />
            <span className={cn(LABEL, "flex-1")}>{l}</span>
            <SkeletonText className="w-[4ch] font-numeric text-xl leading-6" />
          </div>
          <Skeleton className="h-3 rounded-full bg-muted/60" />
        </div>
      ))}
    </div>
  )
}

/** Loading shape: the hero's label and number, the chart box, then the rows with real stage names and their tracks. */
export function SleepStagesSkeleton() {
  return (
    <div aria-hidden className="space-y-4">
      <div>
        <p className={cn(LABEL, "text-foreground-secondary")}>Hours of sleep</p>
        <SkeletonText className={cn(HERO, "mt-1.5 w-[4ch]")} />
        <SkeletonText className="w-[4ch] text-[13px] leading-4" />
      </div>
      <SleepHrChartSkeleton />
      <div className="border-t border-border pt-4">
        <StageRowsSkeleton />
      </div>
    </div>
  )
}
SleepStages.Skeleton = SleepStagesSkeleton
