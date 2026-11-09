import assert from "node:assert/strict";
import test from "node:test";
import { HealthValidationError, MAX_SYNC_BYTES, measurementDay, parseSyncPayload } from "./health.ts";
import { MAX_SLEEP_SEGMENTS, parseMobileSyncPayload } from "./mobile-sync.ts";

const base = () => ({ version: 1, source: "apple-health-shortcuts", timezone: "Asia/Shanghai", exportedAt: "2026-11-09T14:00:00+08:00", measurements: [] as unknown[] });
const segment = (state: unknown = "asleep", startDate = "2026-11-08T23:00:00+08:00", endDate = "2026-11-09T07:00:00+08:00") => ({ state, startDate, endDate });
const report = (segments: unknown[] = []) => ({ day: "2026-11-09", source: "selected-watch", segments });
const upload = (segments: unknown[] = []) => ({ ...base(), sleepReport: report(segments) });
const invalid = (input: unknown, path: string) => assert.throws(() => parseMobileSyncPayload(input), (error: unknown) => {
  assert.ok(error instanceof HealthValidationError);
  assert.ok(error.issues.some((issue) => issue.path.includes(path)), error.message);
  return true;
});

test("original uploads remain fully compatible and unknown top-level fields still fail", () => {
  assert.deepEqual(parseMobileSyncPayload(JSON.stringify(base())), parseSyncPayload(base()));
  invalid({ ...upload(), unexpected: true }, "unexpected");
  invalid({ ...upload(), timezone: "UTC" }, "timezone");
});

test("generic asleep and overlapping sleep stages are unioned rather than counted twice", () => {
  const result = parseMobileSyncPayload(upload([
    segment("asleep"),
    segment("core", "2026-11-08T23:00:00+08:00", "2026-11-09T03:00:00+08:00"),
    segment("deep", "2026-11-09T02:00:00+08:00", "2026-11-09T04:00:00+08:00"),
    segment("rem", "2026-11-09T04:00:00+08:00", "2026-11-09T07:00:00+08:00"),
    segment("in_bed", "2026-11-08T22:00:00+08:00", "2026-11-09T08:00:00+08:00"),
    segment("awake", "2026-11-09T07:00:00+08:00", "2026-11-09T08:00:00+08:00"),
  ]));
  assert.equal(result.measurements.length, 1);
  const sleep = result.measurements[0];
  assert.equal(sleep.value, 8);
  assert.equal(sleep.unit, "hours");
  assert.equal(sleep.source, "selected-watch");
  assert.equal(measurementDay(sleep), "2026-11-09");
  assert.equal(sleep.startDate, "2026-11-08T04:00:00.000Z");
  assert.equal(sleep.endDate, "2026-11-09T04:00:00.000Z");
  assert.deepEqual(parseSyncPayload(result), result);
});

test("separated intervals are added and duplicates do not inflate the total", () => {
  const result = parseMobileSyncPayload(upload([
    segment(3, "2026-11-08T23:00:00+08:00", "2026-11-09T02:00:00+08:00"),
    segment(3, "2026-11-08T23:00:00+08:00", "2026-11-09T02:00:00+08:00"),
    segment(4, "2026-11-09T03:00:00+08:00", "2026-11-09T05:00:00+08:00"),
  ]));
  assert.equal(result.measurements[0].value, 5);
});

test("segments are clipped to the previous-noon/current-noon Shanghai window", () => {
  const result = parseMobileSyncPayload(upload([
    segment(1, "2026-11-08T10:00:00+08:00", "2026-11-08T14:00:00+08:00"),
    segment(5, "2026-11-09T10:00:00+08:00", "2026-11-09T14:00:00+08:00"),
  ]));
  assert.equal(result.measurements[0].value, 4);
});

test("a partial current-day report is clipped to exportedAt", () => {
  const result = parseMobileSyncPayload({ ...upload([segment()]), exportedAt: "2026-11-09T06:00:00+08:00" });
  assert.equal(result.measurements[0].value, 7);
  assert.equal(result.measurements[0].endDate, "2026-11-08T22:00:00.000Z");
  invalid({ ...upload([segment()]), exportedAt: "2026-11-08T23:00:00+08:00" }, "sleepReport.day");
});

test("empty, out-of-window, in-bed and awake-only reports preserve unknown sleep", () => {
  for (const segments of [[], [segment(0)], [segment(2)], [segment("卧床"), segment("清醒")], [segment(1, "2026-11-07T23:00:00+08:00", "2026-11-08T07:00:00+08:00")]]) {
    assert.deepEqual(parseMobileSyncPayload(upload(segments)).measurements, []);
  }
});

test("Apple enum states and common Chinese/English labels are recognized precisely", () => {
  for (const state of [1, 3, 4, 5, "1", "asleep", "Asleep (Core)", "Asleep (Deep)", "Asleep (REM)", "已入睡", "核心睡眠", "深度睡眠", "快速眼动睡眠", "已入睡（核心）", "睡眠（深度）", "已入睡（REM）"]) {
    assert.equal(parseMobileSyncPayload(upload([segment(state)])).measurements[0].value, 8, String(state));
  }
  for (const state of [0, 2, "in_bed", "In Bed", "awake", "卧床时间", "清醒"]) {
    assert.deepEqual(parseMobileSyncPayload(upload([segment(state)])).measurements, [], String(state));
  }
  for (const state of [-1, 6, 1.5, NaN, null, true, "", "not asleep", "unknown", "asleep\n"]) invalid(upload([segment(state)]), ".state");
});

test("sleep source, object shape, and segment fields are strict", () => {
  for (const source of ["", " ", "watch\n", 123, "x".repeat(121)]) invalid({ ...base(), sleepReport: { ...report([segment()]), source } }, "sleepReport.source");
  invalid({ ...base(), sleepReport: null }, "sleepReport");
  invalid({ ...base(), sleepReport: { ...report(), extra: true } }, ".extra");
  invalid(upload([{ ...segment(), source: "second-watch" }]), ".source");
  invalid(upload([null]), "segments[0]");
  invalid({ ...base(), sleepReport: { ...report(), segments: "not-array" } }, ".segments");
});

test("impossible dates, timezone-less segments and reversed intervals fail", () => {
  for (const day of ["2026-02-30", "2026-2-3", "2026-11-09\n", "1970-01-01"]) invalid({ ...base(), sleepReport: { ...report([segment()]), day } }, "sleepReport.day");
  invalid(upload([segment(1, "2026-02-30T23:00:00+08:00")]), ".startDate");
  invalid(upload([segment(1, "2026-11-08T23:00:00")]), ".startDate");
  invalid(upload([segment(1, "2026-11-09T08:00:00+08:00", "2026-11-09T07:00:00+08:00")]), ".endDate");
  invalid(upload([segment(1, "2026-11-09T07:00:00+08:00", "2026-11-09T07:00:00+08:00")]), ".endDate");
});

test("an existing sleep total for the same report day is rejected even for an empty report", () => {
  const existing = {
    id: "sleep-existing", metric: "sleep", value: 8, unit: "hours", aggregation: "daily", source: "selected-watch",
    startDate: "2026-11-08T23:00:00+08:00", endDate: "2026-11-09T07:00:00+08:00",
  };
  invalid({ ...upload(), measurements: [existing] }, "sleepReport");
  const previous = { ...existing, startDate: "2026-11-07T23:00:00+08:00", endDate: "2026-11-08T07:00:00+08:00" };
  assert.equal(parseMobileSyncPayload({ ...upload([segment()]), measurements: [previous] }).measurements.length, 2);
});

test("payload and segment limits include the optional sleep report", () => {
  assert.equal(parseMobileSyncPayload(upload(Array.from({ length: MAX_SLEEP_SEGMENTS }, () => segment()))).measurements[0].value, 8);
  invalid(upload(Array.from({ length: MAX_SLEEP_SEGMENTS + 1 }, () => segment())), ".segments");
  invalid({ ...upload(), padding: "x".repeat(MAX_SYNC_BYTES) }, "$");
  invalid(" ".repeat(MAX_SYNC_BYTES + 1), "$");
  invalid("not JSON", "$");
});
