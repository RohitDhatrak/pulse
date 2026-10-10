// Overnight HRV and SpO2 (scoring version 35): the title, the caption, the spoken summary, and Sleep's card leaving a
// curve out when the night has none.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SleepStages } from "@/components/metrics/SleepStages";
import { NightLineChart, type NightLine } from "./NightLineChart";

const BED = Date.parse("2026-10-01T00:00:00Z");
const WAKE = BED + 6 * 3_600_000;
const night = (values: (number | null)[], cadenceMin: number): NightLine => {
  const points = values.map((v, i) => ({ t: BED + i * cadenceMin * 60_000, v }))
  const real = points.filter((p): p is { t: number; v: number } => p.v !== null)
  const sorted = real.map((p) => p.v).sort((a, b) => a - b)
  const low = real.reduce((m, p) => (p.v < m.v ? p : m))
  const high = real.reduce((m, p) => (p.v > m.v ? p : m))
  return { bed: BED, wake: WAKE, points, low, high, median: sorted[sorted.length >> 1] }
};

describe("NightLineChart", () => {
  it("HRV: titled, with Fitbit's nightly value as its median, and a summary a screen reader can read", () => {
    render(<NightLineChart kind="hrv" night={night([22.5, 25.1, null, 31.3, 28.4, 19.9, 24], 5)} />);
    expect(screen.getByRole("heading", { name: "Overnight HRV" })).toBeInTheDocument();
    expect(screen.getByText("Median 25 ms, Fitbit’s nightly HRV")).toBeInTheDocument();
    expect(screen.getByText(/low 20, median 25, high 31 milliseconds/)).toBeInTheDocument();
  });

  it("SpO2: one decimal, the low in the caption", () => {
    render(<NightLineChart kind="spo2" night={night([96.4, 95.1, 92.8, 97, 98.3, 96.6], 1)} />);
    expect(screen.getByRole("heading", { name: "Overnight blood oxygen" })).toBeInTheDocument();
    expect(screen.getByText("Median 96.6%, low 92.8%")).toBeInTheDocument();
  });

  it("Sleep's card shows a curve only for a night that has it", () => {
    const hours = { value: { asleepMin: 420, average: 410 }, reason: null, provisional: false } as const;
    const hr = { value: null, reason: "no_data", provisional: false } as const;
    const hrv = { value: night([22, 25, 31, 28, 20, 24], 5), reason: null, provisional: false };
    const none = { value: null, reason: "no_data", provisional: false } as const;
    render(<SleepStages hours={hours} hr={hr} hrv={hrv} spo2={none} data={null} />);
    expect(screen.getByRole("heading", { name: "Overnight HRV" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Overnight blood oxygen" })).not.toBeInTheDocument();
  });
});
