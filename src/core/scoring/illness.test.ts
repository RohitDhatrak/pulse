import { describe, expect, it } from "vitest";
import {
  confounderDampen,
  evaluate,
  type IllnessDay,
  illnessFromDays,
  illnessSkipNights,
  type IllnessInputs,
  joinReasons,
  kZToScore,
  perSignalCap,
  raiseThreshold,
  mildThreshold,
  signalZThreshold,
} from "./illness";

const labels = {
  restingHR: "RHR +6",
  skinTemp: "skin temp +0.7 °C",
  hrv: "HRV −22%",
  respiration: "respiration up",
};
const reading = (z: number) => ({ zIllnessward: z });
const classic: IllnessInputs = { restingHR: reading(3.2), skinTemp: reading(3.0), hrv: reading(3.5) };

describe("IllnessSignalEngineTest", () => {
  it("classic three-signal pattern raises", () => {
    const r = evaluate(classic, {}, labels);
    expect(r.level).toBe("raised");
    expect(r.score).toBeGreaterThanOrEqual(raiseThreshold);
    expect(r.signalCount).toBe(3);
    expect(r.firedSignals).toEqual(["RHR +6", "skin temp +0.7 °C", "HRV −22%"]);
    expect(r.suppressedBy).toEqual([]);
    expect(r.copy).toContain("not a diagnosis");
  });

  it("alcohol tag suppresses", () => {
    const raised = evaluate(classic, {}, labels);
    const suppressed = evaluate(classic, { alcohol: true }, labels);
    expect(suppressed.level).toBe("suppressed");
    expect(suppressed.suppressedBy).toEqual(["alcohol"]);
    expect(suppressed.score).toBeLessThan(raised.score);
    expect(suppressed.score).toBeCloseTo(raised.score * confounderDampen, 9);
    expect(suppressed.copy).toContain("alcohol");
    expect(suppressed.copy).toContain("not illness");
    expect(suppressed.copy).toContain("not a diagnosis");
  });

  it("stress, sauna and travel each downgrade with a reason", () => {
    const stress = evaluate(classic, { stress: true }, labels);
    expect(stress.level).toBe("suppressed");
    expect(stress.suppressedBy).toEqual(["stress"]);
    expect(evaluate(classic, { sauna: true }, labels).suppressedBy).toEqual(["sauna"]);
    const travel = evaluate(classic, { travelPhaseJump: true }, labels);
    expect(travel.suppressedBy).toEqual(["travel"]);
    expect(travel.copy).toContain("travel");
  });

  it("multiple confounders join naturally", () => {
    const r = evaluate(classic, { alcohol: true, stress: true }, labels);
    expect(r.suppressedBy).toEqual(["alcohol", "stress"]);
    expect(r.copy).toContain("alcohol and stress");
    expect(joinReasons(["a", "b", "c"])).toBe("a, b and c");
    expect(joinReasons([])).toBe("something");
  });

  it("already unwell switches copy", () => {
    const r = evaluate(classic, { alreadyUnwell: true }, labels);
    expect(r.level).toBe("alreadyUnwell");
    expect(r.copy).toContain("Rest up");
    expect(r.copy).toContain("numbers agree");
    expect(r.copy).not.toContain("Heads-up");
  });

  it("single signal does not raise", () => {
    const r = evaluate({ restingHR: reading(4.0) }, {}, labels);
    expect(r.level).toBe("quiet");
    expect(r.signalCount).toBe(1);
  });

  it("untrusted baseline stays silent", () => {
    const r = evaluate(classic, { baselineTrusted: false }, labels);
    expect(r.level).toBe("quiet");
    expect(r.copy).not.toContain("Heads-up");
  });

  it("below-threshold signals are mild, not raised", () => {
    const r = evaluate({ restingHR: reading(2.6), skinTemp: reading(2.6) }, {}, labels);
    expect(r.signalCount).toBe(2);
    expect(r.level).toBe("mild");
    expect(r.score).toBeLessThan(raiseThreshold);
    expect(r.score).toBeGreaterThanOrEqual(mildThreshold);
  });

  it("absent signals do not count", () => {
    const r = evaluate({ restingHR: reading(3.2), skinTemp: { zIllnessward: 9.0, present: false }, hrv: reading(3.5) }, {}, labels);
    expect(r.signalCount).toBe(2);
    expect(r.firedSignals).not.toContain("skin temp +0.7 °C");
  });

  it("copy never names a condition", () => {
    const banned = ["covid", "flu", "fever", "infection", "sick with", "illness with", "disease"];
    for (const ctx of [{}, { alcohol: true }, { alreadyUnwell: true }]) {
      const copy = evaluate(classic, ctx, labels).copy.toLowerCase();
      for (const b of banned) expect(copy).not.toContain(b);
    }
  });

  it("per-signal score capping", () => {
    const r = evaluate({ restingHR: reading(100.0), skinTemp: reading(2.5) }, {}, labels);
    expect(r.score).toBeCloseTo(perSignalCap + kZToScore * (2.5 - signalZThreshold), 9);
  });
});

describe("V5HealthSignalsTest (illness half)", () => {
  const day = (offset: number, v: Omit<IllnessDay, "day"> = {}): IllnessDay => ({
    day: new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10),
    ...v,
  });
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("different vital rows cannot combine into a trusted illness baseline", () => {
    const history = range(14).map((o) => (o % 2 === 0 ? day(o, { rhr: 55 }) : day(o, { hrv: 50 })));
    const r = illnessFromDays([...history, day(14, { skinTempDev: 0.6, resp: 18 })]);
    expect(r.baselineTrusted).toBe(false);
    expect(r.level).toBe("quiet");
    expect(r.copy).toBe("Still learning your baseline - keeping an eye out.");
  });

  it("fourteen nights for one illness signal are trusted (version 23: in the window that skips the 3 latest)", () => {
    // noop trusts 14 nights before last night; with the 3-night gap that takes 17 nights of history.
    const history = range(17).map((o) => day(o, { rhr: 54 + (o % 3) }));
    expect(illnessFromDays([...history, day(17, { rhr: 64 })]).baselineTrusted).toBe(true);
    expect(illnessFromDays([...history.slice(1), day(17, { rhr: 64 })]).baselineTrusted).toBe(false);
  });

  it("temperature alone never trusts the illness baseline", () => {
    const r = illnessFromDays(range(56).map((o) => day(o, { skinTempDev: 0.2 })));
    expect(r.baselineTrusted).toBe(false);
    expect(r.level).toBe("quiet");
  });

  it("an RHR + HRV + resp shift against a trusted baseline raises (pulse addition)", () => {
    const history = range(20).map((o) => day(o, { rhr: 54 + (o % 3), hrv: 60 + (o % 3) * 2, resp: 14 + (o % 2) * 0.4 }));
    const r = illnessFromDays([...history, day(20, { rhr: 64, hrv: 45, resp: 17 })]);
    expect(r.baselineTrusted).toBe(true);
    expect(r.level).toBe("raised");
    expect(r.firedSignals).toEqual(["RHR up", "HRV down", "respiration up"]);
  });
});

describe("SCORING_VERSION 23: the window skips the nights just before, and a hard or late workout explains a night", () => {
  const day = (offset: number, v: Omit<IllnessDay, "day"> = {}): IllnessDay => ({ day: new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10), ...v });
  const steady = (n: number) => Array.from({ length: n }, (_, o) => day(o, { rhr: 54 + (o % 3), hrv: 60 + (o % 3) * 2, resp: 14 + (o % 2) * 0.4 }));

  it("the 3 nights before last night are not in its baseline", () => {
    const base = steady(30);
    const sick = { rhr: 64, hrv: 45, resp: 17 };
    const clean = illnessFromDays([...base, day(30, sick)]);
    // Three already-sick nights just before: version 22 folded them in and the same night read quieter.
    const withSick = illnessFromDays([...base.slice(3), day(27, sick), day(28, sick), day(29, sick), day(30, sick)]);
    expect(illnessSkipNights).toBe(3);
    expect(withSick.score).toBeCloseTo(illnessFromDays([...base.slice(3), ...base.slice(27, 30), day(30, sick)]).score, 9);
    expect(withSick.level).toBe(clean.level);
    expect(withSick.level).toBe("raised");
  });

  it("a hard or late workout dampens the score and says so, without 'you logged'", () => {
    const r = evaluate(classic, { hardOrLateWorkout: true }, labels);
    expect(r.level).toBe("suppressed");
    expect(r.copy).toContain("yesterday's hard or late workout");
    expect(r.copy).not.toContain("you logged");
    const both = evaluate(classic, { hardOrLateWorkout: true, alcohol: true }, labels);
    expect(both.copy).toContain("the alcohol you logged and yesterday's hard or late workout");
  });
});
