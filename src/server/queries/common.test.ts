import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db";
import { ctxFor, dayAt, seeded } from "../testing";
import { dayStartOf, daySpans, loadDays, ms } from "./common";
import { getStress } from "./health";
import { hrChart } from "./strain";

let db: Db;
beforeAll(async () => {
  db = await seeded();
});

const days = Array.from({ length: 170 }, (_, i) => dayAt(i + 8));

describe("daySpans", () => {
  it("clips the main sleep to the day start and keeps naps as stored", async () => {
    const ctx = ctxFor(db);
    const rows = await loadDays(ctx, days[0], days[days.length - 1]);
    const day = days.find((d) => {
      const s = rows.get(d)?.sleep;
      return s?.main && s.main.start < dayStartOf(ctx, d) && s.naps.length > 0;
    });
    expect(day).toBeDefined();
    const row = rows.get(day!)!;
    const start = dayStartOf(ctx, day!);
    const spans = await daySpans(ctx, row, day!, start);
    expect(spans.find((s) => s.kind === "sleep")).toEqual({ kind: "sleep", label: "Sleep", start: ms(start), end: ms(row.sleep!.main!.end) });
    expect(spans.filter((s) => s.kind === "nap")).toEqual(row.sleep!.naps.map((n) => ({ kind: "nap", label: "Nap", start: ms(n.start), end: ms(n.end) })));
  });

  it("the stress chart and the HR chart show the same spans for a day", async () => {
    const ctx = ctxFor(db);
    const rows = await loadDays(ctx, days[0], days[days.length - 1]);
    const day = days.find((d) => (rows.get(d)?.sleep?.naps.length ?? 0) > 0)!;
    const stress = (await getStress(day, ctx)).chart.value;
    const hr = (await hrChart(ctx, rows.get(day), day, false)).value;
    expect(stress?.spans.length).toBeGreaterThan(0);
    expect(stress?.spans).toEqual(hr?.spans);
  });

  it("an activity window marks workouts only, never the sleep or naps it overlaps", async () => {
    const ctx = ctxFor(db);
    const rows = await loadDays(ctx, days[0], days[days.length - 1]);
    const day = days.find((d) => (rows.get(d)?.sleep?.naps.length ?? 0) > 0)!;
    const start = dayStartOf(ctx, day);
    const hr = (await hrChart(ctx, rows.get(day), day, false, start, start + 86_400)).value;
    expect(hr?.spans.every((s) => s.kind === "workout")).toBe(true);
  });
});
