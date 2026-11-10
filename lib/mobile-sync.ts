import {
  HEALTH_TIMEZONE,
  HealthValidationError,
  MAX_SYNC_BYTES,
  normalizeTimestamp,
  parseSyncPayload,
  measurementDay,
  shanghaiDay,
} from "./health.ts";
import type { HealthSyncPayload, SleepStages, ValidationIssue } from "./health.ts";

export const MAX_SLEEP_SEGMENTS = 3000;
export const MAX_SLEEP_DAYS = 30;

/** Apple Health sleep enum: 0 in bed, 1 asleep, 2 awake, 3 core, 4 deep, 5 REM. */
export type AppleSleepState = 0 | 1 | 2 | 3 | 4 | 5;

const stateAliases: Readonly<Record<string, AppleSleepState>> = {
  "0": 0, in_bed: 0, "in bed": 0, inbed: 0, 卧床: 0, 卧床时间: 0, 卧床中: 0, 在床上: 0,
  "1": 1, asleep: 1, "asleep unspecified": 1, "asleep (unspecified)": 1, asleepunspecified: 1,
  睡眠: 1, 已入睡: 1, 入睡: 1, 睡着: 1, "睡眠(未指定)": 1, "已入睡(未指定)": 1, "睡眠(未分类)": 1,
  "2": 2, awake: 2, 清醒: 2, 清醒时间: 2, 醒着: 2, 已醒: 2,
  "3": 3, core: 3, "asleep core": 3, "asleep (core)": 3, asleepcore: 3,
  核心: 3, 核心睡眠: 3, "已入睡(核心)": 3, "睡眠(核心)": 3,
  "4": 4, deep: 4, "asleep deep": 4, "asleep (deep)": 4, asleepdeep: 4,
  深度: 4, 深度睡眠: 4, 深睡眠: 4, "已入睡(深度)": 4, "睡眠(深度)": 4,
  "5": 5, rem: 5, "asleep rem": 5, "asleep (rem)": 5, asleeprem: 5,
  快速眼动: 5, 快速眼动睡眠: 5, 快速动眼: 5, 快速动眼睡眠: 5,
  "已入睡(快速眼动)": 5, "睡眠(快速眼动)": 5, "已入睡(rem)": 5, "睡眠(rem)": 5,
};

const noonFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: HEALTH_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function fail(path: string, message: string): never {
  throw new HealthValidationError([{ path, message }]);
}

function state(value: unknown): AppleSleepState | null {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 5 ? value as AppleSleepState : null;
  if (typeof value !== "string" || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const key = value.trim().normalize("NFKC").toLowerCase().replace(/\s*\(\s*/g, " (").replace(/\s*\)\s*/g, ")");
  // Chinese Apple display labels have no space before their parentheses.
  const compactChinese = key.replace(/([\u3400-\u9fff]) \(/g, "$1(");
  return Object.hasOwn(stateAliases, compactChinese) ? stateAliases[compactChinese] : null;
}

function shanghaiNoon(day: string): number {
  const first = normalizeTimestamp(`${day}T12:00:00+08:00`);
  if (!first || shanghaiDay(first) !== day) fail("sleepReport.day", "Expected a valid YYYY-MM-DD calendar date");
  const firstDate = new Date(first);
  const hour = Number(noonFormatter.formatToParts(firstDate).find((part) => part.type === "hour")?.value);
  // Also honors Shanghai's historical daylight-saving offset, rather than
  // assuming that every supported historical date used UTC+08:00.
  const noon = firstDate.getTime() - (hour - 12) * 3600000;
  if (!Number.isFinite(noon) || shanghaiDay(new Date(noon).toISOString()) !== day) fail("sleepReport.day", "Unsupported calendar date");
  return noon;
}

/**
 * Optional mobile adapter. The sender must filter sleep samples to one selected
 * source. We count only asleep states and union intervals; in-bed/awake samples
 * never become sleep hours. Each day uses a fixed reporting window, not an assertion
 * that the result equals every roll-up shown in Apple's Health app.
 */
export function parseMobileSyncPayload(input: unknown): HealthSyncPayload {
  let encoded: string;
  try { encoded = typeof input === "string" ? input : JSON.stringify(input); }
  catch { return fail("$", "Expected JSON-serializable data without cycles"); }
  if (typeof encoded !== "string") return fail("$", "Expected a JSON object");
  if (new TextEncoder().encode(encoded).byteLength > MAX_SYNC_BYTES) return fail("$", `Payload exceeds ${MAX_SYNC_BYTES} bytes`);
  let raw: unknown;
  try { raw = typeof input === "string" ? JSON.parse(input) : input; }
  catch { return fail("$", "Invalid JSON"); }
  if (!object(raw)) return fail("$", "Expected a JSON object");
  if (!Object.hasOwn(raw, "sleepReport")) return parseSyncPayload(raw);

  const { sleepReport, ...standardInput } = raw;
  const standard = parseSyncPayload(standardInput);
  if (!object(sleepReport)) return fail("sleepReport", "Expected an object");
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string) => { if (issues.length < 20) issues.push({ path, message }); };
  const reportKeys = new Set(["day", "days", "source", "segments"]);
  for (const key of Object.keys(sleepReport)) if (!reportKeys.has(key)) add(`sleepReport.${key}`, "Unknown field");
  if (typeof sleepReport.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(sleepReport.day) || sleepReport.day.trim() !== sleepReport.day) {
    add("sleepReport.day", "Expected a YYYY-MM-DD calendar date");
  }
  const days = Object.hasOwn(sleepReport, "days") ? sleepReport.days : 1;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_SLEEP_DAYS) {
    add("sleepReport.days", `Expected an integer from 1 to ${MAX_SLEEP_DAYS}`);
  }
  if (typeof sleepReport.source !== "string" || sleepReport.source.trim() !== sleepReport.source || sleepReport.source.length < 1
    || sleepReport.source.length > 120 || /[\u0000-\u001f\u007f]/.test(sleepReport.source)) add("sleepReport.source", "Expected one selected source identifier of 1–120 characters");
  if (!Array.isArray(sleepReport.segments)) add("sleepReport.segments", "Expected an array");
  else if (sleepReport.segments.length > MAX_SLEEP_SEGMENTS) add("sleepReport.segments", `At most ${MAX_SLEEP_SEGMENTS} segments are allowed`);
  if (issues.length) throw new HealthValidationError(issues);

  const finalDay = sleepReport.day as string;
  // Validate before calendar arithmetic so dates such as February 30 cannot
  // normalize silently. Step calendar dates in UTC, then resolve each local
  // noon independently: Shanghai's historical DST windows are not all 24 hours.
  shanghaiNoon(finalDay);
  const finalCalendarDay = Date.parse(`${finalDay}T12:00:00Z`);
  const calendarDay = (offset: number) => new Date(finalCalendarDay + offset * 86400000).toISOString().slice(0, 10);
  const windows = Array.from({ length: days as number }, (_, index) => {
    const offset = index - (days as number) + 1;
    const day = calendarDay(offset);
    const start = shanghaiNoon(calendarDay(offset - 1));
    const end = Math.min(shanghaiNoon(day), Date.parse(standard.exportedAt));
    if (end <= start || shanghaiDay(new Date(end).toISOString()) !== day) {
      return fail("sleepReport.day", "The reporting window must end on its stated day and not after exportedAt");
    }
    return { day, start, end };
  });
  const reportingDays = new Set(windows.map((window) => window.day));
  if (standard.measurements.some((measurement) => measurement.metric === "sleep" && reportingDays.has(measurementDay(measurement)))) {
    return fail("sleepReport", "Do not send both sleepReport and a sleep measurement for the same day");
  }

  const intervals: Array<[number, number, AppleSleepState]> = [];
  const segmentKeys = new Set(["state", "startDate", "endDate"]);
  for (const [index, segment] of (sleepReport.segments as unknown[]).entries()) {
    if (issues.length >= 20) break;
    const path = `sleepReport.segments[${index}]`;
    if (!object(segment)) { add(path, "Expected an object"); continue; }
    const before = issues.length;
    for (const key of Object.keys(segment)) if (!segmentKeys.has(key)) add(`${path}.${key}`, "Unknown field");
    const parsedState = state(segment.state);
    if (parsedState === null) add(`${path}.state`, "Expected a recognized Apple sleep state (0–5 or a supported display label)");
    const start = normalizeTimestamp(segment.startDate);
    const end = normalizeTimestamp(segment.endDate);
    if (!start) add(`${path}.startDate`, "Expected a valid ISO timestamp with a timezone");
    if (!end) add(`${path}.endDate`, "Expected a valid ISO timestamp with a timezone");
    if (start && end && Date.parse(end) <= Date.parse(start)) add(`${path}.endDate`, "End must be after start");
    if (issues.length !== before || parsedState === null) continue;
    intervals.push([Date.parse(start!), Date.parse(end!), parsedState]);
  }
  if (issues.length) throw new HealthValidationError(issues);
  if (intervals.length === 0) return standard;

  const sleepMeasurements = windows.flatMap((window) => {
    const events: Array<{ time: number; state: AppleSleepState; delta: number }> = [];
    for (const [start, end, parsedState] of intervals) {
      const clippedStart = Math.max(start, window.start);
      const clippedEnd = Math.min(end, window.end);
      if (clippedEnd > clippedStart) {
        events.push({ time: clippedStart, state: parsedState, delta: 1 }, { time: clippedEnd, state: parsedState, delta: -1 });
      }
    }
    if (events.length === 0) return [];

    // Partition each day's timeline so detailed stages replace overlapping
    // generic asleep records. Conflicting detailed stages stay unclassified
    // instead of choosing one arbitrarily or counting the same time twice.
    events.sort((left, right) => left.time - right.time);
    const active = [0, 0, 0, 0, 0, 0];
    const milliseconds: SleepStages = { unspecified: 0, core: 0, deep: 0, rem: 0, awake: 0, inBed: 0 };
    let previousTime = events[0].time;
    for (const event of events) {
      const duration = event.time - previousTime;
      if (duration > 0) {
        if (active[0] > 0) milliseconds.inBed += duration;
        if (active[2] > 0) milliseconds.awake += duration;
        const detailed = [3, 4, 5].filter((stage) => active[stage] > 0);
        if (detailed.length === 1) {
          const key = detailed[0] === 3 ? "core" : detailed[0] === 4 ? "deep" : "rem";
          milliseconds[key] += duration;
        } else if (detailed.length > 1 || active[1] > 0) milliseconds.unspecified += duration;
      }
      active[event.state] += event.delta;
      previousTime = event.time;
    }
    const totalMilliseconds = milliseconds.unspecified + milliseconds.core + milliseconds.deep + milliseconds.rem;
    // Missing dates and awake/in-bed-only dates stay absent rather than
    // overwriting saved sleep with a fabricated zero-hour record.
    if (totalMilliseconds === 0) return [];
    const sleepStages: SleepStages = {
      unspecified: milliseconds.unspecified / 3600000,
      core: milliseconds.core / 3600000,
      deep: milliseconds.deep / 3600000,
      rem: milliseconds.rem / 3600000,
      awake: milliseconds.awake / 3600000,
      inBed: milliseconds.inBed / 3600000,
    };
    return [{
      id: `sleep-report:${window.day}`, metric: "sleep", value: totalMilliseconds / 3600000,
      unit: "hours", aggregation: "daily", source: sleepReport.source,
      startDate: new Date(window.start).toISOString(), endDate: new Date(window.end).toISOString(),
      sleepStages,
    }];
  });

  // Run the completed result through the original contract, retaining all of
  // its ID, range, date, source, and maximum-record-count protections.
  return parseSyncPayload({
    ...standard,
    measurements: [...standard.measurements, ...sleepMeasurements],
  });
}
