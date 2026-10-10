import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mapDaily, mapExercises, mapExtra, mapHeartRate, mapHeight, mapNightSamples, mapRecords, mapRollup, mapSleep, mapStepsMinutes } from "./map";

const TZ = "Asia/Kolkata"; // UTC+5:30: a night's UTC date and its local wake day differ
const fixture = (name: string): { dataPoints?: unknown[]; rollupDataPoints?: unknown[] } =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "__fixtures__", `${name}.json`), "utf8"));
const points = (name: string) => fixture(name).dataPoints ?? fixture(name).rollupDataPoints ?? [];
const ts = (iso: string) => Date.parse(iso) / 1000;

describe("daily mappers", () => {
  it("map each daily type's fields to daily_metrics columns, casting int64 strings", () => {
    expect(mapDaily("daily-heart-rate-variability", points("daily-heart-rate-variability"), TZ)).toEqual([
      // The non-REM heart rate arrives as an int64 string (version 35).
      { day: "2026-10-02", hrvMs: 44.5, hrvDeepMs: 49.25, nonRemHrBpm: 55 },
      { day: "2026-10-01", hrvMs: 41.5, hrvDeepMs: 47, nonRemHrBpm: 56 },
    ]);
    expect(mapDaily("daily-resting-heart-rate", points("daily-resting-heart-rate"), TZ)).toContainEqual({
      day: "2026-10-01",
      rhrBpm: 57,
      rhrMethod: "WITH_SLEEP",
    });
    expect(mapDaily("daily-respiratory-rate", points("daily-respiratory-rate"), TZ)).toEqual([{ day: "2026-10-01", respBpm: 14.2 }]);
    // Raw nightly temperature, with Google's baseline and 30-night SD beside it.
    expect(mapDaily("daily-sleep-temperature-derivations", points("daily-sleep-temperature-derivations"), TZ)).toEqual([
      { day: "2026-10-01", nightlyTempC: 34.12, tempBaselineC: 34, tempSdC: 0.21 },
    ]);
    // Zones in Google's order whatever the API's; a day missing a zone has none.
    expect(mapDaily("daily-heart-rate-zones", points("daily-heart-rate-zones"), TZ)).toEqual([
      { day: "2026-10-01", hrZones: [98, 118, 137, 157, 186] },
      { day: "2026-09-30", hrZones: null },
    ]);
    expect(mapDaily("daily-oxygen-saturation", points("daily-oxygen-saturation"), TZ)).toEqual([{ day: "2026-10-01", spo2Pct: 96.4 }]);
    expect(mapDaily("daily-vo2-max", points("daily-vo2-max"), TZ)).toEqual([{ day: "2026-09-30", vo2maxDaily: 44.1 }]);
  });

  it("sample types land on their local day, the latest reading of the day winning", () => {
    expect(mapDaily("weight", points("weight"), TZ)).toEqual([{ day: "2026-09-30", weightKg: 72.1 }]);
    expect(mapDaily("body-fat", points("body-fat"), TZ)).toEqual([{ day: "2026-09-30", bodyFatPct: 18.2 }]);
    // 13:10Z is 18:40 local, still 1 October.
    expect(mapDaily("run-vo2-max", points("run-vo2-max"), TZ)).toEqual([{ day: "2026-10-01", vo2maxRun: 46.3 }]);
  });

  it("dailyRollUp gives step totals and calories by civil day, skipping a day with no value", () => {
    expect(mapRollup("steps", points("steps.dailyRollUp"))).toEqual([
      { day: "2026-10-02", steps: 1200 },
      { day: "2026-10-01", steps: 8421 },
    ]);
    expect(mapRollup("total-calories", points("total-calories.dailyRollUp"))).toEqual([{ day: "2026-10-01", calories: 2310.5 }]);
  });

  it("time in zones: LIGHT + MODERATE and VIGOROUS + PEAK minutes; a point with no zones is skipped", () => {
    expect(mapRollup("time-in-heart-rate-zone", points("time-in-heart-rate-zone.dailyRollUp"))).toEqual([
      { day: "2026-10-01", lightModerateMin: 52, vigorousPeakMin: 450.5 / 60 },
    ]);
  });

  it("personal ranges come from the differently named roll-up values; an inverted range is skipped", () => {
    expect(mapRollup("daily-resting-heart-rate", points("daily-resting-heart-rate.dailyRollUp"))).toEqual([
      { day: "2026-10-01", rhrRangeLow: 52, rhrRangeHigh: 61 },
    ]);
    expect(mapRollup("daily-heart-rate-variability", points("daily-heart-rate-variability.dailyRollUp"))).toEqual([
      { day: "2026-10-01", hrvRangeLow: 31.5, hrvRangeHigh: 55.25 },
    ]);
  });

  it("ignores points without the type's payload", () => {
    expect(mapDaily("daily-respiratory-rate", [{ dataSource: {} }, null, 3], TZ)).toEqual([]);
  });
});

describe("intraday mappers", () => {
  it("heart rate: band only, int64 cast, a repeated second keeps the last point", () => {
    const hr = mapHeartRate(points("heart-rate"));
    expect(hr.get(ts("2026-10-01T00:00:00Z"))).toBe(53);
    expect(hr.get(ts("2026-10-01T00:00:02Z"))).toBe(51);
    expect(hr.has(ts("2026-10-01T12:45:01Z"))).toBe(false); // HEALTH_CONNECT
    expect(hr.size).toBe(5);
  });

  it("overnight HRV and SpO2 samples (version 35): tenths, band only, a repeated second keeps the last, implausible dropped", () => {
    const at = (iso: string) => ({ physicalTime: iso });
    const hrvPoint = (iso: string, v: unknown, platform = "FITBIT") => ({ dataSource: { platform }, heartRateVariability: { sampleTime: at(iso), rootMeanSquareOfSuccessiveDifferencesMilliseconds: v } });
    const hrv = mapNightSamples("heart-rate-variability", [
      hrvPoint("2026-10-01T20:00:00Z", 31.3),
      hrvPoint("2026-10-01T20:05:00Z", "27.46"),
      hrvPoint("2026-10-01T20:05:00Z", 28.2), // the same second again: the last wins
      hrvPoint("2026-10-01T20:10:00Z", 40, "HEALTH_CONNECT"),
      hrvPoint("2026-10-01T20:15:00Z", 0),
      hrvPoint("2026-10-01T20:20:00Z", 900),
      { dataSource: { platform: "FITBIT" }, heartRateVariability: { sampleTime: at("2026-10-01T20:25:00Z") } },
    ]);
    expect([...hrv]).toEqual([
      [ts("2026-10-01T20:00:00Z"), 313],
      [ts("2026-10-01T20:05:00Z"), 282],
    ]);
    const spo2Point = (iso: string, v: number) => ({ dataSource: { platform: "FITBIT" }, oxygenSaturation: { sampleTime: at(iso), percentage: v } });
    const spo2 = mapNightSamples("oxygen-saturation", [spo2Point("2026-10-01T20:00:00Z", 96.4), spo2Point("2026-10-01T20:01:00Z", 100), spo2Point("2026-10-01T20:02:00Z", 101), spo2Point("2026-10-01T20:03:00Z", 30)]);
    expect([...spo2]).toEqual([
      [ts("2026-10-01T20:00:00Z"), 964],
      [ts("2026-10-01T20:01:00Z"), 1000],
    ]);
  });

  it("steps per minute: maximum across sources, a long interval spread over its minutes", () => {
    const steps = mapStepsMinutes(points("steps"));
    expect(steps.get(ts("2026-10-01T03:00:00Z"))).toBe(55); // band 40, phone 55
    expect([1, 2, 3].map((m) => steps.get(ts("2026-10-01T03:00:00Z") + 60 * m))).toEqual([33, 33, 34]);
    expect(steps.get(ts("2026-10-02T05:40:00Z"))).toBe(12);
  });
});

describe("sleep", () => {
  const { sessions, segments, awakenings } = mapSleep(points("sleep"), TZ);
  const byId = (s: string) => sessions.find((x) => x.id.endsWith(s))!;

  it("a session from 23:30 to 07:10 maps to its local wake day, with its summary and lowercase stages", () => {
    const a = byId("sleep-a");
    expect(a).toMatchObject({
      day: "2026-10-01",
      startTs: ts("2026-09-30T18:00:00Z"),
      endTs: ts("2026-10-01T01:40:00Z"),
      isMain: true,
      processed: true,
      stagesStatus: "SUCCEEDED",
      asleepMin: 440,
      awakeMin: 20,
      deepMin: 60,
      lightMin: 320,
      remMin: 60,
      source: "FITBIT",
    });
    const mine = segments.filter((g) => g.sessionId === a.id);
    expect(mine.map((g) => g.stage)).toEqual(["awake", "light", "deep", "rem", "light", "awake"]);
    expect(mine[0]).toEqual({ sessionId: a.id, startTs: ts("2026-09-30T18:00:00Z"), endTs: ts("2026-09-30T18:10:00Z"), stage: "awake" });
  });

  it("brief awakenings (version 35): LIGHT and REM ones of a staged session; an unknown type or no end time is skipped alone", () => {
    const a = byId("sleep-a");
    expect(awakenings.filter((w) => w.sessionId === a.id)).toEqual([
      { sessionId: a.id, startTs: ts("2026-09-30T21:00:00Z"), endTs: ts("2026-09-30T21:01:00Z"), stage: "rem" },
      { sessionId: a.id, startTs: ts("2026-09-30T23:00:00Z"), endTs: ts("2026-09-30T23:02:00Z"), stage: "light" },
    ]);
    // A staged night without the list had none (proto3 omits an empty one).
    expect(awakenings.filter((w) => w.sessionId === byId("sleep-b").id)).toEqual([]);
    // A night that wasn't staged keeps none, even if the list came.
    const failed = structuredClone(points("sleep")[0]) as { sleep: { metadata: { stagesStatus: string } } };
    failed.sleep.metadata.stagesStatus = "FAILED";
    expect(mapSleep([failed], TZ).awakenings).toEqual([]);
  });

  it("when two sessions overlap, the one flagged mainSleep wins even if shorter", () => {
    expect(byId("sleep-b")).toMatchObject({ day: "2026-10-02", isMain: true });
    expect(byId("sleep-c")).toMatchObject({ day: "2026-10-02", isMain: false, processed: false, stagesStatus: null });
    expect(byId("sleep-c").endTs - byId("sleep-c").startTs).toBeGreaterThan(byId("sleep-b").endTs - byId("sleep-b").startTs);
  });

  it("a session whose stages did not succeed keeps its summary minutes and has no segments", () => {
    const d = byId("sleep-d");
    expect(d).toMatchObject({ day: "2026-09-30", isMain: true, stagesStatus: "FAILED", asleepMin: 350, awakeMin: 40, deepMin: null });
    expect(segments.filter((g) => g.sessionId === d.id)).toEqual([]);
  });

  it("with no mainSleep flag on the day, the longer session is main, whatever the order", () => {
    const unflag = (p: unknown) => {
      const c = structuredClone(p) as { sleep: { metadata?: unknown } };
      delete c.sleep.metadata;
      return c;
    };
    const day2 = points("sleep").slice(1, 3).map(unflag); // b (shorter) and c (longer)
    for (const order of [day2, [...day2].reverse()]) {
      const main = mapSleep(order, TZ).sessions.filter((s) => s.isMain);
      expect(main.map((s) => s.id)).toEqual(["users/me/dataTypes/sleep/dataPoints/sleep-c"]);
    }
  });

  it("an explicit mainSleep false on every session of a day leaves the day with no main sleep", () => {
    const nap = structuredClone(points("sleep")[1]) as { sleep: { metadata: { mainSleep: boolean } } };
    nap.sleep.metadata.mainSleep = false;
    expect(mapSleep([nap], TZ).sessions[0].isMain).toBe(false);
  });

  it("an unrecognised stage type drops the whole hypnogram", () => {
    const odd = structuredClone(points("sleep")[0]) as { sleep: { stages: { type: string }[] } };
    odd.sleep.stages[2].type = "RESTLESS";
    expect(mapSleep([odd], TZ).segments).toEqual([]);
  });
});

describe("exercises", () => {
  it("map to their local start day with type, name, calories and metres", () => {
    expect(mapExercises(points("exercise"), TZ)).toEqual([
      {
        id: "users/me/dataTypes/exercise/dataPoints/exercise-a",
        day: "2026-10-01",
        startTs: ts("2026-10-01T12:30:00Z"),
        endTs: ts("2026-10-01T13:10:00Z"),
        type: "RUNNING",
        name: "Run",
        calories: 410.5,
        distanceM: 6543,
        source: "FITBIT",
      },
    ]);
  });
});

describe("extra metrics", () => {
  const day = { civilStartTime: { date: { year: 2026, month: 10, day: 3 } } };
  it("reads each roll-up's value path and converts units", () => {
    expect(mapExtra("distance", [{ ...day, distance: { millimetersSum: "5432100" } }])).toEqual([{ day: "2026-10-03", key: "distance", value: 5.4321 }]);
    expect(mapExtra("altitude", [{ ...day, altitude: { gainMillimetersSum: "12000" } }])).toEqual([{ day: "2026-10-03", key: "elevation", value: 12 }]);
    expect(mapExtra("sedentary-period", [{ ...day, sedentaryPeriod: { durationSum: "36000s" } }])[0].value).toBe(600);
    expect(mapExtra("active-zone-minutes", [{ ...day, activeZoneMinutes: { sumInFatBurnHeartZone: "10", sumInPeakHeartZone: "4" } }])[0].value).toBe(14);
    const am = mapExtra("active-minutes", [
      { ...day, activeMinutes: { activeMinutesRollupByActivityLevel: [{ activityLevel: "LIGHT", activeMinutesSum: "120" }, { activityLevel: "MODERATE", activeMinutesSum: "20" }, { activityLevel: "VIGOROUS", activeMinutesSum: "15" }] } },
    ]);
    expect(Object.fromEntries(am.map((v) => [v.key, v.value]))).toEqual({ active_minutes: 35, light_minutes: 120 });
    const food = mapExtra("nutrition-log", [{ ...day, nutritionLog: { energy: { kcalSum: 1800 }, nutrients: [{ nutrient: "PROTEIN", quantity: { gramsSum: 90 } }] } }]);
    expect(Object.fromEntries(food.map((v) => [v.key, v.value]))).toEqual({ calories_in: 1800, protein: 90 });
  });
  it("skips missing values instead of writing zero", () => {
    expect(mapExtra("floors", [{ ...day, floors: {} }])).toEqual([]);
    expect(mapExtra("water" as never, [])).toEqual([]);
  });
});

describe("height and heart-rhythm records", () => {
  it("keeps the latest height in cm", () => {
    const h = (t: string, mm: string) => ({ height: { sampleTime: { physicalTime: t }, heightMillimeters: mm } });
    expect(mapHeight([h("2026-01-01T00:00:00Z", "1800"), h("2026-06-01T00:00:00Z", "1805")])).toEqual({ ts: 1780272000, cm: 180.5 });
  });
  it("keeps an ECG's result and bpm, never its waveform", () => {
    const [r] = mapRecords("electrocardiogram", [{ name: "e1", electrocardiogram: { interval: { startTime: "2026-10-03T06:00:00Z" }, resultClassification: "NORMAL_SINUS_RHYTHM", beatsPerMinuteAvg: "64", waveformSamples: [1, 2, 3] } }], "Asia/Kolkata");
    expect(r).toEqual({ id: "e1", kind: "ecg", ts: 1791007200, day: "2026-10-03", data: { result: "NORMAL_SINUS_RHYTHM", avgBpm: 64 } });
  });
});
