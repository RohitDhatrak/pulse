import { describe, expect, it } from "vitest";
import { checkInDay, MORNING_ENDS_HOUR } from "./journal";

describe("checkInDay", () => {
  const base = { requested: null, today: "2026-10-03", yesterday: "2026-10-02", yesterdayDone: false };

  it("before noon with yesterday empty: yesterday (a morning check-in is about last night)", () => {
    for (const localHour of [0, 1, 6, 8, 11]) expect(checkInDay({ ...base, localHour })).toBe("2026-10-02");
  });

  it("before noon with yesterday done: today", () => {
    expect(checkInDay({ ...base, localHour: 8, yesterdayDone: true })).toBe("2026-10-03");
  });

  it("from noon: today, whatever yesterday holds", () => {
    expect(MORNING_ENDS_HOUR).toBe(12);
    for (const localHour of [12, 18, 23]) {
      expect(checkInDay({ ...base, localHour })).toBe("2026-10-03");
      expect(checkInDay({ ...base, localHour, yesterdayDone: true })).toBe("2026-10-03");
    }
  });

  it("an explicit day always wins", () => {
    expect(checkInDay({ ...base, requested: "2026-09-20", localHour: 8 })).toBe("2026-09-20");
    expect(checkInDay({ ...base, requested: "2026-10-03", localHour: 8 })).toBe("2026-10-03");
  });
});
