// Pinned score fingerprints: one hash per daily_scores column, per intraday series kind and for reports, on the
// pinned 180-day demo database. A scorer change that moves any value fails here, so it must either bump
// SCORING_VERSION (so every install recomputes) and record new fingerprints, or update them on purpose.
import crypto from "node:crypto";
import { expect, it } from "vitest";
import { type Db, rows, sql } from "../db";
import { SCORING_VERSION } from ".";
import { seeded, USER } from "../testing";

/**
 * Fingerprints per SCORING_VERSION. To update: run this test, copy the "Received" object from the failure into
 * GOLDEN[SCORING_VERSION], and say in the commit why the scores moved. Versions before 6 hashed SQLite's JSON text;
 * 6 was re-recorded for Postgres (sorted jsonb keys) with parity.test.ts proving the scores themselves did not move.
 */
const GOLDEN: Record<number, Record<string, string>> = {
  4: {
    "daily_scores.scoring_version": "7127cc4d409f56c8",
    "daily_scores.strain": "0142128af067d3d9",
    "daily_scores.activities": "73a473e0117e7634",
    "daily_scores.session_rhr_bpm": "eb0c3b3835b4a988",
    "daily_scores.recovery": "48b659063a72ca94",
    "daily_scores.sleep": "4760e092b846b6d0",
    "daily_scores.training_load": "bee5c4c4e8f6fd4e",
    "daily_scores.strain_target": "ee29a80d51723fb7",
    "daily_scores.sleep_planner": "5a6e94255768f61a",
    "daily_scores.energy_bank": "dabfb4821ce758b4",
    "daily_scores.stress": "f07e69608121ab9e",
    "daily_scores.health_monitor": "3186093d465c5164",
    "daily_scores.healthspan": "c6a1e21fa34d302b",
    "daily_scores.fitness": "271fe91d5f634fef",
    "daily_scores.journal_impact": "96829f8a2aa64e1c",
    "intraday_series.energy_bank": "e2d63643740bc4f3",
    "intraday_series.hr": "05de9bb2ba692679",
    "intraday_series.load": "5015ada146270d7c",
    "intraday_series.still_hr": "1f35b44871871769",
    "intraday_series.stress": "a466449cc9fa5819",
    reports: "1c262d6fb0d39aba",
  },
  5: {
    "daily_scores.scoring_version": "aa80152d5fba63f3",
    "daily_scores.strain": "69517e5973ce141f",
    "daily_scores.activities": "73a473e0117e7634",
    "daily_scores.session_rhr_bpm": "eb0c3b3835b4a988",
    "daily_scores.recovery": "48b659063a72ca94",
    "daily_scores.sleep": "4760e092b846b6d0",
    "daily_scores.training_load": "bee5c4c4e8f6fd4e",
    "daily_scores.strain_target": "ee29a80d51723fb7",
    "daily_scores.sleep_planner": "5a6e94255768f61a",
    "daily_scores.energy_bank": "dabfb4821ce758b4",
    "daily_scores.stress": "f07e69608121ab9e",
    "daily_scores.health_monitor": "3186093d465c5164",
    "daily_scores.healthspan": "f995aedb11fa6e2a",
    "daily_scores.fitness": "271fe91d5f634fef",
    "daily_scores.journal_impact": "96829f8a2aa64e1c",
    "intraday_series.energy_bank": "e2d63643740bc4f3",
    "intraday_series.hr": "05de9bb2ba692679",
    "intraday_series.load": "5015ada146270d7c",
    "intraday_series.still_hr": "1f35b44871871769",
    "intraday_series.stress": "a466449cc9fa5819",
    "reports": "1c262d6fb0d39aba",
  },
  6: {
    "daily_scores.scoring_version": "d2623305a0334fca",
    "daily_scores.strain": "a5938298e73c9b8d",
    "daily_scores.activities": "5d40e7c0996983b2",
    "daily_scores.session_rhr_bpm": "2f808b51bd7a0bc8",
    "daily_scores.recovery": "f30d80524db0f63f",
    "daily_scores.sleep": "ccb090c5c5766471",
    "daily_scores.training_load": "c6a22d117dfa06bc",
    "daily_scores.strain_target": "bfcfd859e9c7dd75",
    "daily_scores.sleep_planner": "bf57a92ddfecd8e0",
    "daily_scores.energy_bank": "f822e67fed343673",
    "daily_scores.stress": "a8514c3f8bedce98",
    "daily_scores.health_monitor": "3a2163c7f92d4dab",
    "daily_scores.healthspan": "bd47739ff5d02880",
    "daily_scores.fitness": "cfad8d1954c878ed",
    "daily_scores.journal_impact": "7eed29fa9baca1ea",
    "intraday_series.energy_bank": "237320b091a7a358",
    "intraday_series.hr": "5ca83bb68dad9033",
    "intraday_series.load": "859d8876596ad379",
    "intraday_series.still_hr": "c0bf14266ee71abd",
    "intraday_series.stress": "66d650df74998208",
    "reports": "7c7cfdf8c1583777",
  },
  // 7: five zones on heart-rate reserve. The day's zones (strain), each activity's, and Pulse Age (healthspan), whose
  // zones 1-3 and 4-5 terms now count Pulse's own zones instead of Google's roll-up.
  7: {
    "daily_scores.scoring_version": "4540e362bb306df2",
    "daily_scores.strain": "5002bbb246544891",
    "daily_scores.activities": "1d2f8021722c6b84",
    "daily_scores.session_rhr_bpm": "2f808b51bd7a0bc8",
    "daily_scores.recovery": "f30d80524db0f63f",
    "daily_scores.sleep": "ccb090c5c5766471",
    "daily_scores.training_load": "c6a22d117dfa06bc",
    "daily_scores.strain_target": "bfcfd859e9c7dd75",
    "daily_scores.sleep_planner": "bf57a92ddfecd8e0",
    "daily_scores.energy_bank": "f822e67fed343673",
    "daily_scores.stress": "a8514c3f8bedce98",
    "daily_scores.health_monitor": "3a2163c7f92d4dab",
    "daily_scores.healthspan": "683be47b969df06b",
    "daily_scores.fitness": "cfad8d1954c878ed",
    "daily_scores.journal_impact": "7eed29fa9baca1ea",
    "intraday_series.energy_bank": "237320b091a7a358",
    "intraday_series.hr": "5ca83bb68dad9033",
    "intraday_series.load": "859d8876596ad379",
    "intraday_series.still_hr": "c0bf14266ee71abd",
    "intraday_series.stress": "66d650df74998208",
    "reports": "7c7cfdf8c1583777",
  },  // 8: max HR no longer from Google's PEAK zone; the demo sets its own, so only the stamp and strain's key moved.
  8: {
    "daily_scores.scoring_version": "7e0dd1c597907815",
    "daily_scores.strain": "74dc3c718456b3b5",
    "daily_scores.activities": "1d2f8021722c6b84",
    "daily_scores.session_rhr_bpm": "2f808b51bd7a0bc8",
    "daily_scores.recovery": "f30d80524db0f63f",
    "daily_scores.sleep": "ccb090c5c5766471",
    "daily_scores.training_load": "c6a22d117dfa06bc",
    "daily_scores.strain_target": "bfcfd859e9c7dd75",
    "daily_scores.sleep_planner": "bf57a92ddfecd8e0",
    "daily_scores.energy_bank": "f822e67fed343673",
    "daily_scores.stress": "a8514c3f8bedce98",
    "daily_scores.health_monitor": "3a2163c7f92d4dab",
    "daily_scores.healthspan": "683be47b969df06b",
    "daily_scores.fitness": "cfad8d1954c878ed",
    "daily_scores.journal_impact": "7eed29fa9baca1ea",
    "intraday_series.energy_bank": "237320b091a7a358",
    "intraday_series.hr": "5ca83bb68dad9033",
    "intraday_series.load": "859d8876596ad379",
    "intraday_series.still_hr": "c0bf14266ee71abd",
    "intraday_series.stress": "66d650df74998208",
    "reports": "7c7cfdf8c1583777",
  },
  // 9: baseline spread learned as a running mean over the first nights and z shrunk by n / (n + 2). Recovery and
  // everything downstream of it (energy bank, journal impact, reports) moved, as did Readiness (training load,
  // strain target), the Health Monitor ranges and the daytime-HR stress baseline. Strain's key moves with the
  // version stamp only: Effort and Sleep are unchanged (parity.test.ts).
  9: {
    "daily_scores.scoring_version": "06731b2819e3281d",
    "daily_scores.strain": "60c2ca00c1d33909",
    "daily_scores.activities": "1d2f8021722c6b84",
    "daily_scores.session_rhr_bpm": "2f808b51bd7a0bc8",
    "daily_scores.recovery": "3c95e7ed1511d5ae",
    "daily_scores.sleep": "ccb090c5c5766471",
    "daily_scores.training_load": "567d7878110ac897",
    "daily_scores.strain_target": "96040c38909a9d4d",
    "daily_scores.sleep_planner": "bf57a92ddfecd8e0",
    "daily_scores.energy_bank": "0a1f9754780adc24",
    "daily_scores.stress": "291a11279b7e0c99",
    "daily_scores.health_monitor": "38a813fd4cae5652",
    "daily_scores.healthspan": "683be47b969df06b",
    "daily_scores.fitness": "cfad8d1954c878ed",
    "daily_scores.journal_impact": "4fca8ad358140f31",
    "intraday_series.energy_bank": "bf0680aa15a7c40b",
    "intraday_series.hr": "5ca83bb68dad9033",
    "intraday_series.load": "859d8876596ad379",
    "intraday_series.still_hr": "c0bf14266ee71abd",
    "intraday_series.stress": "1a9c6cffc7a1e62f",
    "reports": "87673c1fac280cf4",
  },
  // 10: training load on linear TRIMP (stored as strain.trimp), calendar-day ACWR windows, ramping down informational
  // (no Strain Target lift), CTL/ATL carried across gaps of up to 3 days. Only strain (the new trimp field and the
  // version stamp), training_load, strain_target and reports (training balance) moved; recovery, Effort and sleep are
  // unchanged (parity.test.ts passes as recorded for version 9).
  10: {
    "daily_scores.scoring_version": "bfc634c893f9c22c",
    "daily_scores.strain": "493a4493412b85cc",
    "daily_scores.activities": "1d2f8021722c6b84",
    "daily_scores.session_rhr_bpm": "2f808b51bd7a0bc8",
    "daily_scores.recovery": "3c95e7ed1511d5ae",
    "daily_scores.sleep": "ccb090c5c5766471",
    "daily_scores.training_load": "e8004f82b9305a58",
    "daily_scores.strain_target": "cd255276abf758ab",
    "daily_scores.sleep_planner": "bf57a92ddfecd8e0",
    "daily_scores.energy_bank": "0a1f9754780adc24",
    "daily_scores.stress": "291a11279b7e0c99",
    "daily_scores.health_monitor": "38a813fd4cae5652",
    "daily_scores.healthspan": "683be47b969df06b",
    "daily_scores.fitness": "cfad8d1954c878ed",
    "daily_scores.journal_impact": "4fca8ad358140f31",
    "intraday_series.energy_bank": "bf0680aa15a7c40b",
    "intraday_series.hr": "5ca83bb68dad9033",
    "intraday_series.load": "859d8876596ad379",
    "intraday_series.still_hr": "c0bf14266ee71abd",
    "intraday_series.stress": "1a9c6cffc7a1e62f",
    "reports": "51c0dbdcab00adac",
  },
  // 11: Strain Target in linear load (typical session × a Recovery multiplier centred on your own 28 days, about one
  // point wide, +10 % per 4 weeks at most, capped when ramping or returning). Only strain_target moved, plus the
  // version stamp (and strain's key, which hashes it).
  11: {
    "daily_scores.scoring_version": "16e50b07b414d86c",
    "daily_scores.strain": "00c33afebe8d5431",
    "daily_scores.activities": "1d2f8021722c6b84",
    "daily_scores.session_rhr_bpm": "2f808b51bd7a0bc8",
    "daily_scores.recovery": "3c95e7ed1511d5ae",
    "daily_scores.sleep": "ccb090c5c5766471",
    "daily_scores.training_load": "e8004f82b9305a58",
    "daily_scores.strain_target": "b95583b5932e682d",
    "daily_scores.sleep_planner": "bf57a92ddfecd8e0",
    "daily_scores.energy_bank": "0a1f9754780adc24",
    "daily_scores.stress": "291a11279b7e0c99",
    "daily_scores.health_monitor": "38a813fd4cae5652",
    "daily_scores.healthspan": "683be47b969df06b",
    "daily_scores.fitness": "cfad8d1954c878ed",
    "daily_scores.journal_impact": "4fca8ad358140f31",
    "intraday_series.energy_bank": "bf0680aa15a7c40b",
    "intraday_series.hr": "5ca83bb68dad9033",
    "intraday_series.load": "859d8876596ad379",
    "intraday_series.still_hr": "c0bf14266ee71abd",
    "intraday_series.stress": "1a9c6cffc7a1e62f",
    "reports": "51c0dbdcab00adac",
  },
  // 12: Sleep Planner extra sleep and the Recovery forecast's strain nudge, one-sided against the typical session.
  // Moved: sleep_planner, recovery (its stored forecast; recovery values unchanged, parity.test.ts) and the version
  // stamp (and strain's key, which hashes it).
  12: {
    "daily_scores.scoring_version": "939826e567133b72",
    "daily_scores.strain": "982b95196843ac88",
    "daily_scores.activities": "1d2f8021722c6b84",
    "daily_scores.session_rhr_bpm": "2f808b51bd7a0bc8",
    "daily_scores.recovery": "cfac343b38091918",
    "daily_scores.sleep": "ccb090c5c5766471",
    "daily_scores.training_load": "e8004f82b9305a58",
    "daily_scores.strain_target": "b95583b5932e682d",
    "daily_scores.sleep_planner": "af4c19bd722155e6",
    "daily_scores.energy_bank": "0a1f9754780adc24",
    "daily_scores.stress": "291a11279b7e0c99",
    "daily_scores.health_monitor": "38a813fd4cae5652",
    "daily_scores.healthspan": "683be47b969df06b",
    "daily_scores.fitness": "cfad8d1954c878ed",
    "daily_scores.journal_impact": "4fca8ad358140f31",
    "intraday_series.energy_bank": "bf0680aa15a7c40b",
    "intraday_series.hr": "5ca83bb68dad9033",
    "intraday_series.load": "859d8876596ad379",
    "intraday_series.still_hr": "c0bf14266ee71abd",
    "intraday_series.stress": "1a9c6cffc7a1e62f",
    "reports": "51c0dbdcab00adac",
  },
  // 13: Stress against your usual still level (folded median), z0 = ln(6.5)/1.5, high needs 2 minutes in a row.
  // Moved: stress and the Energy Bank (daily and intraday), plus the version stamp (and strain's key).
  13: {
    "daily_scores.scoring_version": "d458be542084860d",
    "daily_scores.strain": "15a3635b5d0cc31d",
    "daily_scores.activities": "1d2f8021722c6b84",
    "daily_scores.session_rhr_bpm": "2f808b51bd7a0bc8",
    "daily_scores.recovery": "cfac343b38091918",
    "daily_scores.sleep": "ccb090c5c5766471",
    "daily_scores.training_load": "e8004f82b9305a58",
    "daily_scores.strain_target": "b95583b5932e682d",
    "daily_scores.sleep_planner": "af4c19bd722155e6",
    "daily_scores.energy_bank": "84c3d066a778cf57",
    "daily_scores.stress": "fd09fd3252ff2955",
    "daily_scores.health_monitor": "38a813fd4cae5652",
    "daily_scores.healthspan": "683be47b969df06b",
    "daily_scores.fitness": "cfad8d1954c878ed",
    "daily_scores.journal_impact": "4fca8ad358140f31",
    "intraday_series.energy_bank": "ac9bf5e400af004f",
    "intraday_series.hr": "5ca83bb68dad9033",
    "intraday_series.load": "859d8876596ad379",
    "intraday_series.still_hr": "c0bf14266ee71abd",
    "intraday_series.stress": "8131d5344e8e2307",
    "reports": "51c0dbdcab00adac",
  },
  // 14: Pulse Age counts a missing input as a typical person (no 9/n scaling) and steps and zones 1–3 once, the larger
  // penalty. Moved: healthspan, plus the version stamp (and strain's key).
  14: {
    "daily_scores.scoring_version": "d9daea29ed5fa736",
    "daily_scores.strain": "b4584d0d5eb6b402",
    "daily_scores.activities": "1d2f8021722c6b84",
    "daily_scores.session_rhr_bpm": "2f808b51bd7a0bc8",
    "daily_scores.recovery": "cfac343b38091918",
    "daily_scores.sleep": "ccb090c5c5766471",
    "daily_scores.training_load": "e8004f82b9305a58",
    "daily_scores.strain_target": "b95583b5932e682d",
    "daily_scores.sleep_planner": "af4c19bd722155e6",
    "daily_scores.energy_bank": "84c3d066a778cf57",
    "daily_scores.stress": "fd09fd3252ff2955",
    "daily_scores.health_monitor": "38a813fd4cae5652",
    "daily_scores.healthspan": "5c3f5cb9714fdee6",
    "daily_scores.fitness": "cfad8d1954c878ed",
    "daily_scores.journal_impact": "4fca8ad358140f31",
    "intraday_series.energy_bank": "ac9bf5e400af004f",
    "intraday_series.hr": "5ca83bb68dad9033",
    "intraday_series.load": "859d8876596ad379",
    "intraday_series.still_hr": "c0bf14266ee71abd",
    "intraday_series.stress": "8131d5344e8e2307",
    "reports": "51c0dbdcab00adac",
  },
  // 15: sleep need = the median of the last 28 nights, floored at 7 h asleep for adults (7.5 h before 7 nights). Moved:
  // sleep, sleep_planner, recovery (its sleep term and forecast), strain_target (via Recovery), energy_bank (its start
  // uses sleep), journal_impact (sleepPerf outcomes), reports, plus the version stamp (and strain's key).
  15: {
    "daily_scores.scoring_version": "fab0c4eee005f38d",
    "daily_scores.strain": "949599a25f26cfca",
    "daily_scores.activities": "1d2f8021722c6b84",
    "daily_scores.session_rhr_bpm": "2f808b51bd7a0bc8",
    "daily_scores.recovery": "dcf2b7a548593f76",
    "daily_scores.sleep": "82e3b4ff7229d2b8",
    "daily_scores.training_load": "e8004f82b9305a58",
    "daily_scores.strain_target": "5d4d715b649e74d4",
    "daily_scores.sleep_planner": "1e4416c535fcefe8",
    "daily_scores.energy_bank": "83a22e54d9b7b4c6",
    "daily_scores.stress": "fd09fd3252ff2955",
    "daily_scores.health_monitor": "38a813fd4cae5652",
    "daily_scores.healthspan": "5c3f5cb9714fdee6",
    "daily_scores.fitness": "cfad8d1954c878ed",
    "daily_scores.journal_impact": "65a5dfe1a5ea5093",
    "intraday_series.energy_bank": "0c9de58502be9667",
    "intraday_series.hr": "5ca83bb68dad9033",
    "intraday_series.load": "859d8876596ad379",
    "intraday_series.still_hr": "c0bf14266ee71abd",
    "intraday_series.stress": "8131d5344e8e2307",
    "reports": "13345381397f38c3",
  },
  // 16: the Health Monitor's own ranges are ± 2.5σ (Google's ranges unchanged). Moved: health_monitor, plus the
  // version stamp (and strain's key).
  16: {
    "daily_scores.scoring_version": "3b88f4ed65deb34e",
    "daily_scores.strain": "05ae62fe3fc12968",
    "daily_scores.activities": "1d2f8021722c6b84",
    "daily_scores.session_rhr_bpm": "2f808b51bd7a0bc8",
    "daily_scores.recovery": "dcf2b7a548593f76",
    "daily_scores.sleep": "82e3b4ff7229d2b8",
    "daily_scores.training_load": "e8004f82b9305a58",
    "daily_scores.strain_target": "5d4d715b649e74d4",
    "daily_scores.sleep_planner": "1e4416c535fcefe8",
    "daily_scores.energy_bank": "83a22e54d9b7b4c6",
    "daily_scores.stress": "fd09fd3252ff2955",
    "daily_scores.health_monitor": "a4baa71279549a09",
    "daily_scores.healthspan": "5c3f5cb9714fdee6",
    "daily_scores.fitness": "cfad8d1954c878ed",
    "daily_scores.journal_impact": "65a5dfe1a5ea5093",
    "intraday_series.energy_bank": "0c9de58502be9667",
    "intraday_series.hr": "5ca83bb68dad9033",
    "intraday_series.load": "859d8876596ad379",
    "intraday_series.still_hr": "c0bf14266ee71abd",
    "intraday_series.stress": "8131d5344e8e2307",
    "reports": "13345381397f38c3",
  },
  // 17: Recovery's sleep term centres on your own average sleep performance (prior 28 nights; 0.85 until 7). Moved:
  // recovery and everything that reads it, plus the version stamp (and strain's key). Sleep and strain are unchanged.
  17: {
    "daily_scores.scoring_version": "a95ad63c44f235eb",
    "daily_scores.strain": "e85265870bffd969",
    "daily_scores.activities": "1d2f8021722c6b84",
    "daily_scores.session_rhr_bpm": "2f808b51bd7a0bc8",
    "daily_scores.recovery": "da6e0572ab604901",
    "daily_scores.sleep": "82e3b4ff7229d2b8",
    "daily_scores.training_load": "e8004f82b9305a58",
    "daily_scores.strain_target": "a70cc076e96b17e2",
    "daily_scores.sleep_planner": "1e4416c535fcefe8",
    "daily_scores.energy_bank": "315fd04ffe7a42b9",
    "daily_scores.stress": "fd09fd3252ff2955",
    "daily_scores.health_monitor": "a4baa71279549a09",
    "daily_scores.healthspan": "5c3f5cb9714fdee6",
    "daily_scores.fitness": "cfad8d1954c878ed",
    "daily_scores.journal_impact": "8222bc2ad59d2cab",
    "intraday_series.energy_bank": "d65cff79206354d4",
    "intraday_series.hr": "5ca83bb68dad9033",
    "intraday_series.load": "859d8876596ad379",
    "intraday_series.still_hr": "c0bf14266ee71abd",
    "intraday_series.stress": "8131d5344e8e2307",
    "reports": "8b8aeb4d038d2c1d",
  },
};

// Numbers are rounded to 10 significant digits first, so a last-ulp difference in Math between Node
// versions does not count as a scoring change. Object keys are sorted: jsonb stores them in its own order.
const canon = (v: unknown): unknown =>
  typeof v === "number"
    ? +v.toPrecision(10)
    : Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
const hash = (rs: Record<string, unknown>[]) =>
  crypto
    .createHash("sha256")
    .update(rs.map((r) => Object.values(r).map((v) => JSON.stringify(canon(v))).join("\t")).join("\n"))
    .digest("hex")
    .slice(0, 16);

async function fingerprints(db: Db) {
  const out: Record<string, string> = {};
  const columns = await rows<{ name: string }>(
    db,
    sql`select column_name as name from information_schema.columns
        where table_name = 'daily_scores' and column_name not in ('day', 'user_id') order by ordinal_position`,
  );
  for (const { name } of columns) {
    out[`daily_scores.${name}`] = hash(await rows(db, sql`select day, ${sql.identifier(name)} from daily_scores where user_id = ${USER} order by day`));
  }
  const kinds = await rows<{ kind: string }>(db, sql`select distinct kind from intraday_series where user_id = ${USER} order by kind`);
  for (const { kind } of kinds) {
    out[`intraday_series.${kind}`] = hash(await rows(db, sql`select day, data from intraday_series where user_id = ${USER} and kind = ${kind} order by day`));
  }
  out.reports = hash(await rows(db, sql`select period, data from reports where user_id = ${USER} order by period`));
  return out;
}

it(`the demo database scores exactly as pinned for SCORING_VERSION ${SCORING_VERSION}`, async () => {
  const actual = await fingerprints(await seeded());
  expect(
    GOLDEN[SCORING_VERSION],
    `no fingerprints for SCORING_VERSION ${SCORING_VERSION}: add GOLDEN[${SCORING_VERSION}] = ${JSON.stringify(actual, null, 2)}`,
  ).toBeDefined();
  expect(actual, "scores changed: bump SCORING_VERSION and record the new fingerprints, or update them if the change is intended").toEqual(
    GOLDEN[SCORING_VERSION],
  );
});
