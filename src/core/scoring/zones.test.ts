import { describe, expect, it } from "vitest";
import { secondsInZone, timeInZone, totalSeconds, zoneNumber, zones } from "./zones";

describe("HrZonesTest", () => {
  it("a huge positive gap is capped at the median interval", () => {
    const tiz = timeInZone(
      [
        { ts: 0, bpm: 135 },
        { ts: 1, bpm: 135 },
        { ts: 2, bpm: 135 },
        { ts: 3602, bpm: 135 },
      ],
      zones(60, 200),
    );
    expect(totalSeconds(tiz)).toBeLessThan(10);
    expect(secondsInZone(tiz, 1)).toBeCloseTo(totalSeconds(tiz), 9);
  });
});

describe("zones", () => {
  it("five zones on heart-rate reserve: resting + 50/60/70/80/90% of (max − resting), top zone open", () => {
    const zs = zones(60, 200); // reserve 140
    expect(zs.zones.map((z) => z.lower)).toEqual([130, 144, 158, 172, 186]);
    expect([129, 130, 143, 144, 158, 172, 186, 210].map((b) => zoneNumber(zs, b))).toEqual([0, 1, 1, 2, 3, 4, 5, 5]);
    const hr = [...Array(60)].map((_, i) => ({ ts: i * 2, bpm: i < 30 ? 90 : 150 }));
    const tiz = timeInZone(hr, zs);
    expect(tiz.seconds).toHaveLength(5);
    expect(tiz.belowZone1).toBe(60);
    expect(secondsInZone(tiz, 2)).toBe(60); // (150 − 60) / 140 = 64%
    expect(totalSeconds(tiz)).toBe(120);
    expect(secondsInZone(tiz, 9)).toBe(0);
  });

  it("a reserve under 1 bpm is treated as 1, so the zones stay ordered", () => {
    const zs = zones(190, 180);
    expect(zs.zones.map((z) => z.number)).toEqual([1, 2, 3, 4, 5]);
    expect(zs.zones[0].lower).toBeLessThan(zs.zones[4].lower);
  });
});
