import { render, screen } from "@testing-library/react"
import { expect, it } from "vitest"
import { Evidence } from "./Evidence"

it("shows coverage, dates and a source link for a sparse trend", () => {
  render(<Evidence name="get_trend" output={{ metric: "Recovery", key: "recovery", unit: "%", start: "2026-09-30", end: "2026-10-02", observedDays: 1, calendarDays: 3, average: { value: 80, reason: null, provisional: true }, previous: { average: { value: null } }, points: [{ value: null }, { value: 80 }, { value: null }] }} />)
  expect(screen.getByText("1 of 3 days measured")).toBeVisible()
  expect(screen.getByRole("link")).toHaveAttribute("href", "/trends?metric=recovery")
  expect(screen.getByText("Provisional")).toBeVisible()
});

it("keeps weak habit evidence visible without claiming causation", () => {
  render(<Evidence name="get_journal_impacts" output={{ outcome: "recovery", unit: "%", effects: [{ behaviour: "Late meal", delta: -2, yesDays: 6, noDays: 7, confidenceInterval: [-5, 1], effect: "none" }] }} />)
  expect(screen.getByText("6 days with, 7 without")).toBeVisible()
  expect(screen.getByText(/90% interval: -5.0 to 1.0.*No clear association/)).toBeVisible()
  expect(screen.getByText(/not proof of cause/)).toBeVisible()
});

it("labels a possible habit effect as possible, and a clear one plainly", () => {
  render(<Evidence name="get_journal_impacts" output={{ outcome: "sleep", unit: "%", effects: [
    { behaviour: "Alcohol", delta: -2.7, yesDays: 20, noDays: 56, confidenceInterval: [-4.7, -0.8], effect: "negative", strength: "possible" },
    { behaviour: "Illness", delta: -24, yesDays: 6, noDays: 77, confidenceInterval: [-39.4, -8.9], effect: "negative", strength: "clear" },
  ] }} />)
  expect(screen.getByText(/-4.7 to -0.8.*Possible association\./)).toBeVisible()
  expect(screen.getByText(/-39.4 to -8.9 %\.$/)).toBeVisible()
});

it("an unavailable sleep metric stays missing and never displays a fabricated bedtime", () => {
  const missing = { value: null, reason: "awaiting_sleep_sync", provisional: false }
  render(<Evidence name="get_sleep" output={{ day: "2026-10-02", timeZone: "Asia/Kolkata", asleepMinutes: missing, summary: [], details: [], planner: missing }} />)
  expect(screen.getAllByText(/Waiting for/).length).toBeGreaterThan(0)
  expect(screen.queryByText(/planned bedtimes/)).not.toBeInTheDocument()
  expect(screen.getByRole("link")).toHaveAttribute("href", "/sleep?d=2026-10-02")
});

it("old saved trend results still have a usable evidence link", () => {
  render(<Evidence name="get_trend" output={{ metric: "Recovery", periods: [] }} />)
  expect(screen.getByRole("link")).toHaveAttribute("href", "/trends")
});
