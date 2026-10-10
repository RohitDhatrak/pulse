// A device switch, from the source of each main sleep (scoring version 34; docs/data-from.md). Google merges daily
// metrics across sources, so only sleep sessions (and exercises) say which device recorded them: `FITBIT` for the band,
// `HEALTH_CONNECT` for a phone or another watch. When the main sleeps move to a new source and stay there, the old
// device's history would keep shaping every baseline (on the owner's account resting HR differed by 5.5 bpm and SpO2 by
// 4 points between the two devices), so Pulse suggests counting data from the switch. It never applies it by itself.

export const deviceSwitchConfig = {
  /** Main sleeps in a row from the new source, up to the latest, before a switch is suggested. */
  minNewNights: 3,
  /** Main sleeps from the old source before the switch: less history isn't worth starting over for. */
  minOldNights: 7,
};

export type DeviceSwitch = {
  /** The wake day of the new source's first main sleep: the day to count data from. */
  day: string;
  from: string;
  to: string;
};

/**
 * The latest switch of main-sleep source, or null. The new source must hold for the last `minNewNights` main sleeps in
 * a row (a single night from another source, such as a stray phone sync, doesn't count), and the old one must have
 * `minOldNights` main sleeps before it.
 * @param mains main sleeps, any order; `day` is the wake day (yyyy-MM-dd).
 */
export function detectDeviceSwitch(mains: { day: string; source: string }[]): DeviceSwitch | null {
  const c = deviceSwitchConfig;
  const nights = [...mains].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  if (!nights.length) return null;
  const to = nights[nights.length - 1].source;
  let i = nights.length - 1;
  while (i > 0 && nights[i - 1].source === to) i--;
  if (nights.length - i < c.minNewNights || i === 0) return null;
  const from = nights[i - 1].source;
  // The old device's run: the nights just before the switch, ignoring single nights from a third source.
  let old = 0;
  for (let k = i - 1; k >= 0; k--) {
    if (nights[k].source === from) old++;
    else if (nights[k].source === to) break;
  }
  return old >= c.minOldNights ? { day: nights[i].day, from, to } : null;
}
