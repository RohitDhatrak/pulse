"use server";
// Onboarding and Settings › Profile (U19). One action for both: onboarding sends `onboarding=1` and moves on to Home.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser, SIGNED_OUT } from "../auth";
import { getDb } from "../db";
import { z } from "zod";
import { dismissDeviceSwitch, ProfileInput, saveProfile, setDataFrom } from "../profile";
import type { ActionResult } from "./journal";
import { requestSync } from "../worker";

export type ProfileFormState =
  | { ok: true; error?: undefined; fields?: undefined }
  | { ok: false; error?: string; fields?: Partial<Record<keyof ProfileInput, string>> }
  | null;

const optional = (v: FormDataEntryValue | null) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export async function saveProfileAction(_: ProfileFormState, form: FormData): Promise<ProfileFormState> {
  const user = await currentUser();
  if (!user) return SIGNED_OUT;
  const r = ProfileInput.safeParse({
    birthDate: form.get("birthDate"),
    sex: form.get("sex") ?? undefined,
    maxHr: optional(form.get("maxHr")),
    heightCm: optional(form.get("heightCm")),
    timeZone: form.get("timeZone") ?? undefined,
  });
  if (!r.success) {
    const fields: Partial<Record<keyof ProfileInput, string>> = {};
    for (const i of r.error.issues) fields[i.path[0] as keyof ProfileInput] ??= i.path[0] === "birthDate" && i.code !== "custom" ? "Enter your birth date" : i.message;
    return { ok: false, fields };
  }
  // Every day is marked for recompute; the worker runs past its 5-minute gate so scores catch up now.
  if (await saveProfile(getDb(), user.userId, r.data)) requestSync({ userId: user.userId, force: true });
  revalidatePath("/", "layout");
  if (form.get("onboarding") === "1") redirect("/");
  return { ok: true };
}

const Day = z.iso.date();

/**
 * Settings › Count my data from (scoring version 34): sets the first local day that counts, or clears it with null.
 * Every day is re-scored from there; earlier data stays stored, so clearing it brings everything back.
 */
export async function setDataFromAction(day: string | null): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return SIGNED_OUT;
  if (day !== null && !Day.safeParse(day).success) return { ok: false, error: "Choose a date" };
  const today = new Date().toISOString().slice(0, 10);
  if (day !== null && day > today) return { ok: false, error: "Choose a date that isn't in the future" };
  if (await setDataFrom(getDb(), user.userId, day)) requestSync({ userId: user.userId, force: true });
  revalidatePath("/", "layout");
  return { ok: true, data: undefined };
}

/** Hides the device-switch suggestion for that day; nothing else changes. */
export async function dismissDeviceSwitchAction(day: string): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return SIGNED_OUT;
  if (!Day.safeParse(day).success) return { ok: false, error: "Choose a date" };
  await dismissDeviceSwitch(getDb(), user.userId, day);
  revalidatePath("/", "layout");
  return { ok: true, data: undefined };
}
