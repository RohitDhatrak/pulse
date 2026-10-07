import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { DriverList } from "./DriverList"

describe("DriverList impact tiers", () => {
  const items = [
    { key: "alcohol", label: "Alcohol", delta: -22, effect: "negative" as const, yes: 20, no: 56, ci: [-30, -14] as [number, number] },
    { key: "late_meal", label: "Late meal", delta: -7, effect: "negative" as const, tentative: true, yes: 12, no: 64, ci: [-13, -1] as [number, number] },
    { key: "sauna", label: "Sauna", delta: 1, effect: "none" as const, yes: 9, no: 67, ci: [-17, 17] as [number, number] },
  ]
  const view = () => render(<DriverList variant="impact" unit="%" outcome="Recovery" data={{ value: items, reason: null, provisional: false }} />)

  it("words a clear effect plainly and a possible one as 'may have'", () => {
    view()
    expect(screen.getByText(/^Alcohol lowered next-day Recovery by 22/)).toBeInTheDocument()
    expect(screen.getByText(/^Late meal may have lowered next-day Recovery by 7 percent, a possible effect/)).toBeInTheDocument()
    expect(screen.getByText(/^Sauna had no clear effect/)).toBeInTheDocument()
  })

  it("draws a possible effect lighter and captions it", () => {
    const { container } = view()
    const bars = [...container.querySelectorAll("li")].map((li) => li.querySelector("span.absolute.inset-y-0")?.className ?? "")
    expect(bars[0]).toMatch(/\bbg-warning(?!\/)/)
    expect(bars[1]).toMatch(/bg-warning\/40/)
    expect(bars[2]).toMatch(/bg-muted-foreground/)
    expect(screen.getAllByText(/Possible effect\./)).toHaveLength(1)
  })
})
