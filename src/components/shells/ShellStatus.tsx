"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

/** Global shell state read by the headers, nav, sync status and ConnectionBanner (spec §4.2, D2). */
export type ShellStatus = {
  mode: "demo" | "google"
  sync: { state: "ok" | "syncing" | "stale" | "error"; lastSuccessAt: number | null }
  connection: "connected" | "not_connected" | "not_linked" | "no_device" | "importing" | "auth_revoked" | "stale"
  importProgress?: { done: number; total: number }
  /** Today (YYYY-MM-DD) in the user's zone, from the server, so client and server agree. */
  today: string
  /** First stored day; the DateSwitcher's prev button and calendar stop here. */
  firstDay?: string
  /** IANA zone for clock times in client-rendered charts. */
  timeZone?: string
  /** Consecutive worn days (Home header streak pill, spec §4.3); null or missing at 0. */
  streak?: { days: number; asOf: string } | null
  /** The avatar photo (src/server/avatar.ts); null draws the outline person icon. */
  avatar?: string | null
  /** This user may use the coach: the round P action opens it instead of the check-in. */
  coach?: boolean
  /** The signed-in account. The offline check-in queue is kept per account, so it never replays into another one. */
  userId?: number
}

const Ctx = React.createContext<ShellStatus | null>(null)

/** The calendar facts most components need: they change once a day, not on every sync. */
export type ShellCalendar = Pick<ShellStatus, "today" | "firstDay" | "timeZone">
const CalendarCtx = React.createContext<ShellCalendar | null>(null)

/** How often the client asks `/status` while a sync or import runs. */
export const STATUS_POLL_MS = 2000

const busy = (s: ShellStatus) => s.sync.state === "syncing" || s.connection === "importing"

/**
 * Two contexts, so a sync or a `router.refresh()` re-renders only what shows sync state (headers, banner, nav
 * status), not every chart and date control. The server sends a new status object on each refresh, so both values
 * are rebuilt only when their fields actually change: a refresh with nothing new re-renders no consumer.
 *
 * The server renders the status once per navigation, so while a sync or import runs the provider polls `/status`
 * for the sync ring and import progress, and refreshes the page once the run ends to bring in the new scores.
 */
export function ShellStatusProvider({ value, live = false, children }: { value: ShellStatus; live?: boolean; children: React.ReactNode }) {
  const router = useRouter()
  const [polled, setPolled] = React.useState<{ from: ShellStatus; status: ShellStatus } | null>(null)
  // A new server render (navigation, refresh) supersedes what polling saw. Avatar, coach and userId only come from the layout.
  const current = polled?.from === value ? { ...polled.status, avatar: value.avatar, coach: value.coach, userId: value.userId } : value
  // Only the real app polls: a fixture that says "syncing" would poll, refresh and say "syncing" again, forever.
  const running = live && busy(current)
  React.useEffect(() => {
    if (!running) return
    let live = true
    const id = setInterval(async () => {
      try {
        const res = await fetch("/status", { cache: "no-store" })
        if (!res.ok || !live) return
        const next = (await res.json()) as ShellStatus
        if (!live) return
        setPolled({ from: value, status: next })
        if (!busy(next)) router.refresh()
      } catch {
        // Offline or signed out: the next tick or navigation tries again.
      }
    }, STATUS_POLL_MS)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [running, value, router])

  const { today, firstDay, timeZone } = current
  const calendar = React.useMemo(() => ({ today, firstDay, timeZone }), [today, firstDay, timeZone])
  const key = JSON.stringify(current)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content: a new object with the same fields is the same status
  const status = React.useMemo(() => current, [key])
  return (
    <CalendarCtx.Provider value={calendar}>
      <Ctx.Provider value={status}>{children}</Ctx.Provider>
    </CalendarCtx.Provider>
  )
}

/** The full status: sync state, connection, import progress, streak, avatar. For the chrome that shows them. */
export function useShellStatus() {
  const v = React.useContext(Ctx)
  if (!v) throw new Error("useShellStatus must be used inside AppShell")
  return v
}

/** Like useShellStatus, for kit components that also render outside a shell (tests, gallery). */
export const useOptionalShellStatus = () => React.useContext(Ctx)

/** Today, the first stored day and the time zone. Prefer this over useShellStatus when that is all you read. */
export function useShellCalendar() {
  const v = React.useContext(CalendarCtx)
  if (!v) throw new Error("useShellCalendar must be used inside AppShell")
  return v
}

/** Like useShellCalendar, for kit components that also render outside a shell (tests, gallery). */
export const useOptionalShellCalendar = () => React.useContext(CalendarCtx)
