import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { JournalTag } from "@/server/queries/types"
import { ShellStatusProvider } from "@/components/shells/ShellStatus"
import { CheckIn, CheckInSheet, changedEntries } from "./CheckIn"

const tags: JournalTag[] = [{ tag: "alcohol", label: "Alcohol", group: "evening", isDefault: true, hidden: false }]
const checkIn = { done: true, entries: { alcohol: 1 }, yes: [{ tag: "alcohol", label: "Alcohol" }] }
const h = vi.hoisted(() => ({
  save: vi.fn<(input: unknown) => Promise<{ ok: true; data: undefined }>>(async () => ({ ok: true, data: undefined })),
  load: vi.fn(),
}))
vi.mock("@/server/actions/journal", () => ({ saveJournalEntry: h.save, addCustomTag: vi.fn(), loadCheckIn: h.load }))
vi.mock("next/navigation", async () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: (await import("@/components/shells/testing")).useLocationSearchParams,
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }))

describe("changedEntries", () => {
  it("sends changed answers, and null for a cleared saved answer", () => {
    expect(changedEntries({ alcohol: undefined, sauna: 0, travel: 1, illness: 1 }, { alcohol: 1, sauna: 1, illness: 1 })).toEqual([
      ["alcohol", null],
      ["sauna", false],
      ["travel", true],
    ])
  })

  it("an unsaved pick cleared again sends nothing", () => {
    expect(changedEntries({ alcohol: undefined }, {})).toEqual([])
  })
})

describe("CheckInSheet", () => {
  const app = (
    <ShellStatusProvider value={{ mode: "demo", sync: { state: "ok", lastSuccessAt: 1 }, connection: "connected", today: "2026-10-03" }}>
      <CheckIn dayLabel="Fri, Oct 2" checkIn={checkIn} />
      <CheckInSheet />
    </ShellStatusProvider>
  )

  it("opens over the screen for its day; unselecting a saved Yes and saving clears it and closes", async () => {
    window.history.replaceState(null, "", "/strain?d=2026-10-02")
    h.load.mockResolvedValue({ ok: true, data: { day: "2026-10-02", tags, checkIn } })
    const back = vi.spyOn(window.history, "back").mockImplementation(() => window.history.replaceState(null, "", "/strain?d=2026-10-02"))
    render(app)
    fireEvent.click(screen.getByRole("button", { name: "Edit check-in" }))
    expect(window.location.pathname + window.location.search).toBe("/strain?d=2026-10-02&checkin=1")
    const yes = within(await screen.findByRole("radiogroup", { name: "Alcohol" })).getByRole("radio", { name: "Yes" })
    expect(h.load).toHaveBeenCalledWith("2026-10-02")
    expect(yes).toHaveAttribute("aria-checked", "true")
    fireEvent.click(yes)
    expect(yes).toHaveAttribute("aria-checked", "false")
    fireEvent.click(screen.getByRole("button", { name: "Save check-in" }))
    await waitFor(() => expect(h.save).toHaveBeenCalledExactlyOnceWith({ day: "2026-10-02", tag: "alcohol", value: null }))
    await waitFor(() => expect(back).toHaveBeenCalledOnce())
    expect(window.location.search).toBe("?d=2026-10-02")
    back.mockRestore()
  })

  it("Back with unsaved answers asks first, and Keep editing restores the entry", async () => {
    window.history.replaceState(null, "", "/?checkin=1")
    h.load.mockResolvedValue({ ok: true, data: { day: "2026-10-03", tags, checkIn } })
    render(app)
    const yes = within(await screen.findByRole("radiogroup", { name: "Alcohol" })).getByRole("radio", { name: "Yes" })
    fireEvent.click(yes)
    act(() => {
      window.history.replaceState(null, "", "/")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    expect(await screen.findByRole("dialog", { name: "Discard changes?" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))
    expect(window.location.search).toBe("?checkin=1")
    expect(yes).toHaveAttribute("aria-checked", "false")
  })

  // A check-in is about an evening. Without `?d=` the server picks it (yesterday before noon if yesterday is empty).
  describe("which evening", () => {
    const empty = { done: false, entries: {}, yes: [] }

    it("with no ?d= it lets the server choose, names the evening, and saves to that day", async () => {
      window.history.replaceState(null, "", "/?checkin=1")
      h.load.mockReset()
      h.save.mockClear()
      h.load.mockResolvedValue({ ok: true, data: { day: "2026-10-02", tags, checkIn: empty } })
      render(app)
      await screen.findByRole("radiogroup", { name: "Alcohol" })
      expect(h.load).toHaveBeenCalledWith(null)
      expect(screen.getByText("Evening of Fri, Oct 2")).toBeInTheDocument()
      const evening = screen.getByRole("radiogroup", { name: "Which evening" })
      expect(within(evening).getByRole("radio", { name: "Yesterday" })).toHaveAttribute("aria-checked", "true")
      fireEvent.click(within(screen.getByRole("radiogroup", { name: "Alcohol" })).getByRole("radio", { name: "Yes" }))
      fireEvent.click(screen.getByRole("button", { name: "Save check-in" }))
      await waitFor(() => expect(h.save).toHaveBeenCalledExactlyOnceWith({ day: "2026-10-02", tag: "alcohol", value: true }))
    })

    it("switching to Today loads today's answers", async () => {
      window.history.replaceState(null, "", "/?checkin=1")
      h.load.mockReset()
      h.load.mockImplementation(async (day: string | null) =>
        day === "2026-10-03" ? { ok: true, data: { day: "2026-10-03", tags, checkIn } } : { ok: true, data: { day: "2026-10-02", tags, checkIn: empty } }
      )
      render(app)
      await screen.findByText("Evening of Fri, Oct 2")
      fireEvent.click(within(screen.getByRole("radiogroup", { name: "Which evening" })).getByRole("radio", { name: "Today" }))
      expect(await screen.findByText("Evening of Sat, Oct 3")).toBeInTheDocument()
      expect(h.load).toHaveBeenLastCalledWith("2026-10-03")
      expect(within(await screen.findByRole("radiogroup", { name: "Alcohol" })).getByRole("radio", { name: "Yes" })).toHaveAttribute("aria-checked", "true")
    })

    it("can't switch with unsaved answers", async () => {
      window.history.replaceState(null, "", "/?checkin=1")
      h.load.mockReset()
      h.load.mockResolvedValue({ ok: true, data: { day: "2026-10-02", tags, checkIn: empty } })
      render(app)
      fireEvent.click(within(await screen.findByRole("radiogroup", { name: "Alcohol" })).getByRole("radio", { name: "No" }))
      const today = within(screen.getByRole("radiogroup", { name: "Which evening" })).getByRole("radio", { name: "Today" })
      expect(today).toBeDisabled()
      fireEvent.click(today)
      expect(h.load).toHaveBeenCalledTimes(1)
    })

    it("an older day (explicit ?d=) has no switch", async () => {
      window.history.replaceState(null, "", "/?d=2026-09-28&checkin=1")
      h.load.mockReset()
      h.load.mockResolvedValue({ ok: true, data: { day: "2026-09-28", tags, checkIn: empty } })
      render(app)
      await screen.findByRole("radiogroup", { name: "Alcohol" })
      expect(h.load).toHaveBeenCalledWith("2026-09-28")
      expect(screen.getByText("Evening of Mon, Sep 28")).toBeInTheDocument()
      expect(screen.queryByRole("radiogroup", { name: "Which evening" })).toBeNull()
    })
  })
})
