import { notFound } from "next/navigation"
import { cn } from "@/lib/utils"
import { clock, dayLabel, formatValue, hmm } from "@/lib/format"
import { dayHref } from "@/lib/url"
import { IntradayHrChart } from "@/components/charts/IntradayHrChart"
import { ZoneBars } from "@/components/charts/ZoneBars"
import { ACTIVITY_ICON } from "@/components/metrics/ActivityCard"
import { InsightCard } from "@/components/metrics/InsightCard"
import { KeyStatRow } from "@/components/metrics/KeyStatRow"
import { ReasonPlaceholder } from "@/components/metrics/ReasonPlaceholder"
import { StatusChip, ValueUnit } from "@/components/metrics/primitives"
import { DetailShell } from "@/components/shells/DetailShell"
import { SectionShell } from "@/components/shells/SectionShell"
import { Card } from "@/components/ui/card"
import { getActivity } from "@/server/queries/activity"
import { todayOf, userCtx } from "@/server/queries/common"
import type { ActivityVM } from "@/server/queries/types"
import { CAPTION, hrSeries, statProps } from "../../_lib/view"

export const metadata = { title: "Activity", description: "Activity strain, heart rate, zones and recovery after the workout." }

/** Activity `/activity/[id]` (spec §7.4). No date switcher; back falls back to that day's Strain. */
export default async function ActivityPage({ params }: PageProps<"/activity/[id]">) {
  const { id } = await params
  const ctx = await userCtx()
  const vm = await getActivity(decodeURIComponent(id), ctx)
  if (!vm) notFound()
  const { timeZone } = ctx
  const today = todayOf(ctx)

  const Icon = ACTIVITY_ICON[vm.kind]
  // No heart rate at all (band off): one notice replaces the empty chart, the empty zones and the dashed heart-rate
  // tiles, instead of the same "band not worn" line three times over an empty page.
  const noHr = vm.hr.value === null && vm.zones.value === null
  const tiles = vm.stats.filter((k) => k.key !== "duration" && !(noHr && k.metric.value === null))

  return (
    <DetailShell
      title={vm.name}
      subtitle={`${dayLabel(vm.day, today)} ${clock(vm.start, timeZone)} to ${clock(vm.end, timeZone)}`}
      align="start"
      titleIcon={<Icon />}
      backHref={dayHref("/strain", vm.day, today)}
      hero={<Hero vm={vm} />}
      // the reference app draws the heart rate and the zone rows on the ground, not in cards [latest-activity-1].
      primary={
        noHr ? (
          <Card className="items-center gap-0 px-4 py-2">
            <ReasonPlaceholder reason={vm.hr.reason} size="md" copy={noHrCopy(vm.hr.reason)} />
          </Card>
        ) : (
          <div className="space-y-6">
            <section aria-labelledby="hr-title">
              <h2 id="hr-title" className="sr-only">
                Heart rate
              </h2>
              <IntradayHrChart variant="activity" data={hrSeries(vm.hr, vm.maxHr)} />
            </section>
            <section aria-labelledby="zones-title">
              <h2 id="zones-title" className="sr-only">
                Time in zones
              </h2>
              <ZoneBars variant="rows" data={vm.zones} note={vm.zoneNote} emptyCopy="No heart-rate zones for this activity." />
            </section>
          </div>
        )
      }
      secondary={[
        tiles.length > 0 && (
          <SectionShell key="stats" variant="section" title="Key statistics" aside="vs. 30-day average" level={2} className={cn("flex flex-col", noHr && "xl:col-span-2")}>
            <div className={cn("grid flex-1 grid-cols-2 gap-3 xl:gap-4", tiles.length > 2 && "md:grid-cols-3")}>
              {tiles.map((k, i) => {
                // An odd last tile spans the phone's two columns as a wide strip that spells out its comparison.
                const wide = tiles.length % 2 === 1 && i === tiles.length - 1
                return <KeyStatRow key={k.key} variant="tile" {...statProps(k)} wide={wide && "md"} className={cn(wide && "max-md:col-span-2")} />
              })}
            </div>
          </SectionShell>
        ),
        // A titled section like Key statistics beside it, so both columns carry a heading and their cards start and end
        // on one line on laptop (SYM8). Without heart rate there is nothing to recover from, and the notice says why.
        !noHr && (
          <SectionShell key="hrr" variant="section" title="Heart rate recovery" level={2} className="flex flex-col">
            <Card className="flex-1 justify-center gap-0 p-4 xl:p-5">
              <HeartRateRecovery hrr={vm.hrr} />
            </Card>
          </SectionShell>
        ),
      ].filter(Boolean)}
      footer={vm.insight && <InsightCard body={vm.insight} />}
    />
  )
}

const STAT_LABEL = "text-xs leading-4 font-bold tracking-[0.1em] text-foreground-secondary uppercase"

/** the reference app's activity hero [latest-activity-1]: a left-aligned stat pair at 34 px (spec §11 F14), activity strain in blue and the duration. */
function Hero({ vm }: { vm: ActivityVM }) {
  const s = vm.strain.value
  const duration = vm.stats.find((k) => k.key === "duration")?.metric.value ?? (vm.end - vm.start) / 60_000
  return (
    <div className="w-full space-y-2">
      <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
        <div>
          <p className="font-numeric text-[34px] leading-none font-bold tabular-nums">
            <span className={s === null ? "text-muted-foreground" : "text-strain-text"}>{formatValue("decimal1", s)}</span>
          </p>
          <p className={cn(STAT_LABEL, "mt-2")}>Activity strain</p>
        </div>
        <div>
          <p className="font-numeric text-[34px] leading-none font-bold tabular-nums">{hmm(duration)}</p>
          <p className={cn(STAT_LABEL, "mt-2")}>Duration</p>
        </div>
      </div>
      {s === null ? (
        // The band-off notice under the hero already says why; repeating it here was the first of three copies.
        vm.hr.value !== null && <ReasonPlaceholder reason={vm.strain.reason} size="sm" />
      ) : (
        vm.dayStrain !== null && (
          <p className={CAPTION}>
            Day strain <span className="font-numeric tabular-nums">{formatValue("decimal1", vm.dayStrain)}</span>
          </p>
        )
      )}
    </div>
  )
}

/** The one band-off notice: what is missing and why. */
function noHrCopy(reason: string | null | undefined) {
  const what = "heart rate, zones or strain for this activity"
  return reason === "band_not_worn" ? `Band not worn, so there's no ${what}.` : `Too little heart-rate data to show ${what}.`
}

function HeartRateRecovery({ hrr }: { hrr: ActivityVM["hrr"] }) {
  if (hrr.value === null) return <ReasonPlaceholder reason="insufficient_hr_data" size="md" copy="Not enough heart-rate data after the workout." />
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <ValueUnit value={formatValue("int", hrr.value.value)} unit="bpm" className="font-numeric text-4xl leading-10 font-bold tracking-[-0.01em]" />
        <StatusChip tone={hrr.value.tone}>{hrr.value.label}</StatusChip>
      </div>
      <p className={`${CAPTION} max-w-[65ch] text-pretty`}>Drop in the first 60 seconds after you stopped. Above 20 is typical for fit adults.</p>
    </div>
  )
}
