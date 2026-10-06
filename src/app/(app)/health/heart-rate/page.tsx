import { dayLabel } from "@/lib/format"
import { getHeartRate } from "@/server/queries/health"
import { ZoneBars } from "@/components/charts/ZoneBars"
import { DetailShell } from "@/components/shells/DetailShell"
import { SectionShell } from "@/components/shells/SectionShell"
import { pageDay, type SearchParams } from "../../_lib/day"
import { HeartRateChart, HeartRateHero, LiveHeartRate } from "./LiveHeartRate"

export const metadata = { title: "Heart rate", description: "Your latest heart rate, today’s minute-by-minute chart and time in heart-rate zones." }

const INFO = {
  title: "About heart rate",
  body: (
    <>
      <p>Your band records heart rate through the day. Fitbit uploads it to Google Health, and Pulse reads it from there.</p>
      <p>While this screen is open on today, Pulse checks for new readings every minute. A reading usually arrives one to three minutes after your band takes it, so the newest one is never quite now.</p>
      <p>The chart shows each minute’s average. Minutes without a reading, when the band was off or not syncing, stay blank.</p>
    </>
  ),
}

/** Heart rate `/health/heart-rate?d=`: the latest reading (live on today), the day's minutes and time in zones. */
export default async function HeartRatePage({ searchParams }: PageProps<"/health/heart-rate">) {
  const { d, today, ctx } = await pageDay(searchParams as SearchParams, "/health/heart-rate")
  const vm = await getHeartRate(d, ctx)
  return (
    // Keyed by day: the live view seeds its state from vm once, so switching days must remount it, not keep the old day.
    <LiveHeartRate key={d} vm={vm}>
      <DetailShell
        title="Heart rate"
        dateSwitcher={{ mode: "day" }}
        info={INFO}
        hero={<HeartRateHero />}
        primary={
          <SectionShell variant="card" level={2} title={vm.isToday ? "Today" : dayLabel(d, today)}>
            <HeartRateChart />
          </SectionShell>
        }
        secondary={[
          <SectionShell key="zones" variant="card" level={2} title="Time in zones" className="xl:col-span-2">
            <ZoneBars variant="rows" data={vm.zones} note={vm.zoneNote} emptyCopy={vm.isToday ? "No heart-rate zones yet today." : "No heart-rate zones on this day."} />
          </SectionShell>,
        ]}
      />
    </LiveHeartRate>
  )
}
