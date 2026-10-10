"use client"

import * as React from "react"
import { Smartphone } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { DAY, formatDay } from "@/lib/format"
import { dismissDeviceSwitchAction, setDataFromAction } from "@/server/actions/profile"
import type { SettingsVM } from "@/server/queries/types"
import { SectionShell } from "@/components/shells/SectionShell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const BODY = "max-w-[65ch] text-[15px] leading-[22px] text-pretty text-foreground-secondary"

/** A Google data-source platform as people know it. */
export const deviceName = (source: string) =>
  source === "FITBIT" ? "your Fitbit" : source === "HEALTH_CONNECT" ? "a phone or watch (Health Connect)" : "another device"

/**
 * Settings › Count my data from (scoring version 34): scores, baselines, charts and reports start on this day, as if
 * earlier days didn't exist; the data stays stored. A detected device switch is offered here, never applied by itself.
 */
// The caller keys it on the saved day, so a new date starts the field from it.
export function DataFrom({ vm, today }: { vm: SettingsVM["dataFrom"]; today: string }) {
  const [value, setValue] = React.useState(vm.day ?? "")
  const [pending, setPending] = React.useState(false)
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setPending(true)
    const r = await fn().catch(() => ({ ok: false, error: "Couldn’t save. Check your connection and try again." }))
    setPending(false)
    if (!r.ok) return toast.error(r.error ?? "Couldn’t save")
    toast.success(done)
  }
  const save = (day: string | null) => run(() => setDataFromAction(day), day ? `Counting your data from ${formatDay(day, DAY.full)}` : "Counting all your data again")
  const s = vm.suggestion
  return (
    <SectionShell variant="card" level={2} id="data-from" title="Count my data from">
      {s && (
        <div role="note" aria-labelledby="device-switch-title" className="mb-4 rounded-xl bg-foreground/[0.04] p-4">
          <p id="device-switch-title" className="flex items-center gap-2 text-[15px] leading-[22px] font-semibold">
            <Smartphone aria-hidden className="size-4 shrink-0" strokeWidth={2} />
            Looks like a new device since {formatDay(s.day, DAY.monthDay)}
          </p>
          <p className={cn(BODY, "mt-1")}>
            Your sleep moved from {deviceName(s.from)} to {deviceName(s.to)}. Devices measure differently, so counting from {formatDay(s.day, DAY.monthDay)} gives
            your scores a clean start. You can change it back any time.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button size="touch" className="w-full" disabled={pending} onClick={() => save(s.day)}>
              Use {formatDay(s.day, DAY.monthDay)}
            </Button>
            <Button size="touch" variant="secondary" className="w-full" disabled={pending} onClick={() => run(() => dismissDeviceSwitchAction(s.day), "Suggestion dismissed")}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      <p className={BODY}>
        Scores, baselines, charts and reports start on this day, as if earlier days didn’t exist. Earlier data stays stored, and clearing the date brings it
        back.
      </p>
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void save(value || null)
        }}
      >
        <label htmlFor="data-from-day" className="sr-only">
          First day to count
        </label>
        <Input id="data-from-day" type="date" max={today} value={value} onChange={(e) => setValue(e.target.value)} className="h-11 flex-1" />
        <Button type="submit" size="touch" disabled={pending || value === (vm.day ?? "")}>
          Save
        </Button>
        {vm.day && (
          <Button type="button" size="touch" variant="secondary" disabled={pending} onClick={() => save(null)}>
            Clear
          </Button>
        )}
      </form>
      <p className="mt-2 text-[13px] leading-[18px] text-muted-foreground">
        {vm.day ? `Counting from ${formatDay(vm.day, DAY.full)}.` : "Counting all your data."}
      </p>
    </SectionShell>
  )
}
