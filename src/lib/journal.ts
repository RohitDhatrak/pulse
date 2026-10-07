// The check-in's behaviour groups and icons, shared by the check-in sheet and More › Behaviours.
import { Bath, Coffee, Flower2, Plane, Smartphone, StretchHorizontal, Tag, Thermometer, Utensils, Wine, type LucideIcon } from "lucide-react";
import type { JournalTag } from "@/server/queries/types";

const ICON: Record<string, LucideIcon> = {
  alcohol: Wine,
  late_caffeine: Coffee,
  late_meal: Utensils,
  screen_in_bed: Smartphone,
  meditation: Flower2,
  stretching: StretchHorizontal,
  sauna: Bath,
  travel: Plane,
  illness: Thermometer,
};
export const tagIcon = (tag: string): LucideIcon => ICON[tag] ?? Tag;

export const TAG_GROUPS: { key: JournalTag["group"]; title: string }[] = [
  { key: "evening", title: "Evening" },
  { key: "recovery", title: "Recovery" },
  { key: "context", title: "Context" },
  { key: "custom", title: "Your behaviours" },
];

/** The Insights footer, under the list and in each behaviour's sheet. */
export const IMPACT_FOOTER =
  "Effects are differences in averages, not proof of cause. A clear effect holds up after allowing for the many behaviours compared; a possible one may be chance, so keep logging. Change one habit at a time to see what it really does.";

/** Before this local hour, an unasked-for check-in opens on yesterday evening when yesterday has none. */
export const MORNING_ENDS_HOUR = 12;

/**
 * The day a check-in records (its evening). An explicit `requested` day (`?d=`) wins. Otherwise, before noon with no
 * check-in yesterday, it is yesterday: a morning check-in is almost always about last night, and saving it under
 * today would pair it with the wrong night's Recovery.
 */
export function checkInDay(a: { requested: string | null; today: string; yesterday: string; localHour: number; yesterdayDone: boolean }): string {
  if (a.requested) return a.requested;
  return a.localHour < MORNING_ENDS_HOUR && !a.yesterdayDone ? a.yesterday : a.today;
}
