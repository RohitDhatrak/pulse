import { describe, expect, it } from "vitest";
import { withTypical } from "./activity";

const row = (zone: number, seconds: number) => ({ zone, label: `Z${zone}`, min: 100 + zone * 10, max: null, seconds });

describe("withTypical", () => {
  it("adds the mean seconds and mean share per zone over earlier activities", () => {
    const m = { value: [row(1, 600), row(2, 0)], reason: null, provisional: false };
    const out = withTypical(m, [
      [300, 300],
      [900, 0],
    ]);
    expect(out.value?.[0].typical).toEqual({ seconds: 600, share: 0.75 });
    expect(out.value?.[1].typical).toEqual({ seconds: 150, share: 0.25 });
  });
  it("leaves the rows alone without earlier activities", () => {
    const m = { value: [row(1, 600)], reason: null, provisional: false };
    expect(withTypical(m, [])).toBe(m);
  });
});
