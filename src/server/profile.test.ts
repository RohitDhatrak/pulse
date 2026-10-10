import { describe, expect, it } from "vitest";
import { rows, sql } from "./db";
import { dailyMetrics } from "./db/schema";
import { dismissDeviceSwitch, getProfile, ProfileInput, saveProfile, setDataFrom } from "./profile";
import { wholeYears } from "./time";
import { addUser, freshDb, seeded, USER } from "./testing";

const input = { birthDate: "1990-06-15", sex: "female", maxHr: null, heightCm: 165, timeZone: "Asia/Kolkata" } as const;

describe("profile", () => {
  it("is null before onboarding", async () => {
    expect(await getProfile(await freshDb(), USER)).toBeNull();
  });

  it("estimates max HR from age (Tanaka) unless measured", async () => {
    const db = await freshDb();
    await saveProfile(db, USER, input);
    // Age 36 on 2026-10-02: 208 - 0.7 * 36 = 182.8
    expect(await getProfile(db, USER, "2026-10-02")).toEqual({ birthDate: "1990-06-15", sex: "female", maxHr: 183, maxHrSource: "estimated", heightCm: 165, timeZone: "Asia/Kolkata", dataFrom: null, deviceSwitchDismissed: null });
    // Birthday not reached yet, age 35: 183.5
    expect((await getProfile(db, USER, "2026-06-14"))!.maxHr).toBe(184);
    await saveProfile(db, USER, { ...input, maxHr: 190 });
    expect(await getProfile(db, USER)).toMatchObject({ maxHr: 190, maxHrSource: "set" });
  });

  it("without the user's own, max HR is Tanaka's estimate, never the top of Google's peak zone (a flat 220)", async () => {
    const db = await freshDb();
    const other = await addUser(db);
    await saveProfile(db, USER, input);
    await db.insert(dailyMetrics).values([
      { userId: USER, day: "2026-09-30", hrZones: [98, 118, 137, 157, 186], source: "google" },
      { userId: USER, day: "2026-10-01", hrZones: [30, 119, 145, 177, 220], source: "google" },
      { userId: other, day: "2026-10-02", hrZones: [99, 119, 138, 158, 199], source: "google" },
    ]);
    const age = wholeYears(input.birthDate, "2026-10-02");
    expect(await getProfile(db, USER, "2026-10-02")).toMatchObject({ maxHr: Math.round(208 - 0.7 * age), maxHrSource: "estimated" });
    await saveProfile(db, USER, { ...input, maxHr: 190 });
    expect(await getProfile(db, USER)).toMatchObject({ maxHr: 190, maxHrSource: "set" });
    expect(await getProfile(db, other)).toBeNull();
  });

  it("saving a change marks every day for recompute; saving the same values does nothing", async () => {
    const db = await seeded();
    const count = async (q: ReturnType<typeof sql>) => (await rows<{ n: number }>(db, q))[0].n;
    const days = await count(sql`select count(distinct day) n from daily_metrics where user_id = ${USER}`);
    const dirty = () => count(sql`select count(*) n from intraday_dirty`);
    expect(await dirty()).toBe(0);
    expect(await saveProfile(db, USER, input)).toBe(true);
    expect(await dirty()).toBe(days);
    await db.execute(sql`delete from intraday_dirty`);
    expect(await saveProfile(db, USER, input)).toBe(false);
    expect(await dirty()).toBe(0);
    expect(await saveProfile(db, USER, { ...input, timeZone: "UTC" })).toBe(true);
    expect(await dirty()).toBe(days);
  });

  it("count my data from (version 34): set, change and clear it, each marking every day for recompute; the same value does nothing", async () => {
    const db = await seeded();
    await saveProfile(db, USER, input);
    const count = async (q: ReturnType<typeof sql>) => (await rows<{ n: number }>(db, q))[0].n;
    const days = await count(sql`select count(distinct day) n from daily_metrics where user_id = ${USER}`);
    const dirty = () => count(sql`select count(*) n from intraday_dirty`);
    await db.execute(sql`delete from intraday_dirty`);
    expect(await setDataFrom(db, USER, "2026-08-01")).toBe(true);
    expect((await getProfile(db, USER))!.dataFrom).toBe("2026-08-01");
    expect(await dirty()).toBe(days);
    await db.execute(sql`delete from intraday_dirty`);
    expect(await setDataFrom(db, USER, "2026-08-01")).toBe(false);
    expect(await dirty()).toBe(0);
    expect(await setDataFrom(db, USER, null)).toBe(true);
    expect((await getProfile(db, USER))!.dataFrom).toBeNull();
    expect(await dirty()).toBe(days);
    // Before onboarding there is no profile to set it on.
    expect(await setDataFrom(await freshDb(), USER, "2026-08-01")).toBe(false);
  });

  it("dismissing a device-switch suggestion stores its day and changes nothing else", async () => {
    const db = await seeded();
    await saveProfile(db, USER, input);
    const before = await getProfile(db, USER);
    await dismissDeviceSwitch(db, USER, "2026-10-04");
    expect(await getProfile(db, USER)).toEqual({ ...before, deviceSwitchDismissed: "2026-10-04" });
  });

  it("validates input, coercing form strings", () => {
    expect(ProfileInput.parse({ birthDate: "1990-06-15", sex: "male", maxHr: "185", heightCm: "178.5", timeZone: "UTC" })).toEqual({
      birthDate: "1990-06-15",
      sex: "male",
      maxHr: 185,
      heightCm: 178.5,
      timeZone: "UTC",
    });
    for (const bad of [
      { ...input, birthDate: "15/06/1990" },
      { ...input, birthDate: new Date().toISOString().slice(0, 10) },
      { ...input, sex: "x" },
      { ...input, maxHr: 300 },
      { ...input, heightCm: 20 },
      { ...input, timeZone: "Mars/Olympus" },
    ])
      expect(ProfileInput.safeParse(bad).success).toBe(false);
  });
});
