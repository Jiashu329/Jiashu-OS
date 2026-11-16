import assert from "node:assert/strict";
import test from "node:test";
import { HealthValidationError, MAX_SYNC_BYTES, measurementDay, parseSyncPayload } from "./health.ts";
import { MAX_SLEEP_DAYS, MAX_SLEEP_SEGMENTS, parseMobileSyncPayload } from "./mobile-sync.ts";

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
  assert.deepEqual(sleep.sleepStages, { unspecified: 1, core: 3, deep: 1, rem: 3, awake: 1, inBed: 10 });
  assert.deepEqual(parseSyncPayload(result), result);
});

test("separated intervals are added and duplicates do not inflate the total", () => {
  const result = parseMobileSyncPayload(upload([
    segment(3, "2026-11-08T23:00:00+08:00", "2026-11-09T02:00:00+08:00"),
    segment(3, "2026-11-08T23:00:00+08:00", "2026-11-09T02:00:00+08:00"),
    segment(4, "2026-11-09T03:00:00+08:00", "2026-11-09T05:00:00+08:00"),
  ]));
  assert.equal(result.measurements[0].value, 5);
  assert.deepEqual(result.measurements[0].sleepStages, { unspecified: 0, core: 3, deep: 2, rem: 0, awake: 0, inBed: 0 });
});

test("segments are clipped to the previous-noon/current-noon Shanghai window", () => {
  const result = parseMobileSyncPayload(upload([
    segment(1, "2026-11-08T10:00:00+08:00", "2026-11-08T14:00:00+08:00"),
    segment(5, "2026-11-09T10:00:00+08:00", "2026-11-09T14:00:00+08:00"),
  ]));
  assert.equal(result.measurements[0].value, 4);
  assert.deepEqual(result.measurements[0].sleepStages, { unspecified: 2, core: 0, deep: 0, rem: 2, awake: 0, inBed: 0 });
});

test("a partial current-day report is clipped to exportedAt", () => {
  const result = parseMobileSyncPayload({ ...upload([segment()]), exportedAt: "2026-11-09T06:00:00+08:00" });
  assert.equal(result.measurements[0].value, 7);
  assert.equal(result.measurements[0].endDate, "2026-11-08T22:00:00.000Z");
  assert.deepEqual(result.measurements[0].sleepStages, { unspecified: 7, core: 0, deep: 0, rem: 0, awake: 0, inBed: 0 });
  invalid({ ...upload([segment()]), exportedAt: "2026-11-08T23:00:00+08:00" }, "sleepReport.day");
});

test("stage breakdown is independent of input order and generic or detailed duplicates", () => {
  const segments = [
    segment(1), segment(1),
    segment(3, "2026-11-08T23:00:00+08:00", "2026-11-09T02:00:00+08:00"),
    segment(3, "2026-11-09T00:00:00+08:00", "2026-11-09T02:00:00+08:00"),
    segment(4, "2026-11-09T02:00:00+08:00", "2026-11-09T04:00:00+08:00"),
    segment(5, "2026-11-09T04:00:00+08:00", "2026-11-09T06:00:00+08:00"),
  ];
  const forward = parseMobileSyncPayload(upload(segments));
  const backward = parseMobileSyncPayload(upload([...segments].reverse()));
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward.measurements[0].sleepStages, { unspecified: 1, core: 3, deep: 2, rem: 2, awake: 0, inBed: 0 });
});

test("awake and in-bed intervals are unioned separately and never added to sleep", () => {
  const result = parseMobileSyncPayload(upload([
    segment(1),
    segment(2, "2026-11-08T22:00:00+08:00", "2026-11-09T00:00:00+08:00"),
    segment(2, "2026-11-08T23:00:00+08:00", "2026-11-09T01:00:00+08:00"),
    segment(0, "2026-11-08T22:00:00+08:00", "2026-11-09T08:00:00+08:00"),
    segment(0, "2026-11-08T22:00:00+08:00", "2026-11-09T08:00:00+08:00"),
  ]));
  assert.equal(result.measurements[0].value, 8);
  assert.deepEqual(result.measurements[0].sleepStages, { unspecified: 8, core: 0, deep: 0, rem: 0, awake: 3, inBed: 10 });
});

test("all stage totals share the same partial reporting window, including awake and in-bed", () => {
  const result = parseMobileSyncPayload({
    ...upload([
      segment(1),
      segment(4, "2026-11-09T03:00:00+08:00", "2026-11-09T07:00:00+08:00"),
      segment(2, "2026-11-08T10:00:00+08:00", "2026-11-08T14:00:00+08:00"),
      segment(0, "2026-11-08T10:00:00+08:00", "2026-11-09T08:00:00+08:00"),
    ]),
    exportedAt: "2026-11-09T06:00:00+08:00",
  });
  assert.equal(result.measurements[0].value, 7);
  assert.deepEqual(result.measurements[0].sleepStages, { unspecified: 4, core: 0, deep: 3, rem: 0, awake: 2, inBed: 18 });
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
  for (const state of [0, 2, "in_bed", "In Bed", "awake", "卧床时间", "清醒", "清醒时间"]) {
    assert.deepEqual(parseMobileSyncPayload(upload([segment(state)])).measurements, [], String(state));
  }
  for (const state of [-1, 6, 1.5, NaN, null, true, "", "not asleep", "unknown", "asleep\n"]) invalid(upload([segment(state)]), ".state");
});

test("iPhone display labels preserve sleep stages and exclude awake time across a 30-day import", () => {
  const input = { ...base(), sleepReport: { ...report([
    segment("核心睡眠", "2026-10-11T23:00:00+08:00", "2026-10-12T00:00:00+08:00"),
    segment("清醒时间", "2026-10-12T00:00:00+08:00", "2026-10-12T00:15:00+08:00"),
    segment("深度睡眠", "2026-10-12T00:15:00+08:00", "2026-10-12T01:15:00+08:00"),
    segment("快速动眼睡眠", "2026-10-12T01:15:00+08:00", "2026-10-12T02:15:00+08:00"),
    segment("清醒时间", "2026-10-13T03:00:00+08:00", "2026-10-13T04:00:00+08:00"),
  ]), days: 30 } };
  const before = structuredClone(input);
  const parsed = parseMobileSyncPayload(input);
  assert.deepEqual(parsed.measurements.map((record) => [measurementDay(record), record.value]), [["2026-10-12", 3]]);
  assert.deepEqual(parsed.measurements[0].sleepStages, { unspecified: 0, core: 1, deep: 1, rem: 1, awake: 0.25, inBed: 0 });
  assert.deepEqual(input, before);
  assert.deepEqual(parseMobileSyncPayload({ ...base(), sleepReport: { ...report([
    segment("清醒时间", "2026-10-12T00:00:00+08:00", "2026-10-12T00:15:00+08:00"),
  ]), days: 30 } }).measurements, []);
  // Recognize Apple's exact label without accepting arbitrary suffixes.
  invalid(upload([segment("未知时间")]), ".state");
});

test("the iPhone sleep-time label counts as unclassified sleep without duplicating detailed stages", () => {
  const parsed = parseMobileSyncPayload(upload([
    segment("睡眠时间", "2026-11-08T23:00:00+08:00", "2026-11-09T02:00:00+08:00"),
    segment("核心睡眠", "2026-11-09T00:00:00+08:00", "2026-11-09T01:00:00+08:00"),
    segment("深度睡眠", "2026-11-09T01:00:00+08:00", "2026-11-09T02:00:00+08:00"),
    segment("清醒时间", "2026-11-09T02:00:00+08:00", "2026-11-09T02:30:00+08:00"),
    segment("卧床时间", "2026-11-08T22:00:00+08:00", "2026-11-09T03:00:00+08:00"),
  ]));
  assert.equal(parsed.measurements.length, 1);
  assert.equal(parsed.measurements[0].value, 3);
  assert.deepEqual(parsed.measurements[0].sleepStages, { unspecified: 1, core: 1, deep: 1, rem: 0, awake: 0.5, inBed: 5 });
  invalid(upload([segment("睡眠时间未知")]), ".state");
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

test("multiple nights produce separate daily totals while preserving the original sample order", () => {
  const input = { ...base(), sleepReport: { ...report([
    segment(4),
    segment(1, "2026-11-07T23:00:00+08:00", "2026-11-08T06:00:00+08:00"),
    segment(3, "2026-11-08T23:00:00+08:00", "2026-11-09T03:00:00+08:00"),
    segment(3, "2026-11-07T23:00:00+08:00", "2026-11-08T02:00:00+08:00"),
  ]), days: 3 } };
  const snapshot = structuredClone(input);
  const result = parseMobileSyncPayload(input);
  assert.deepEqual(result.measurements.map((measurement) => [measurementDay(measurement), measurement.value]), [
    ["2026-11-08", 7], ["2026-11-09", 8],
  ]);
  assert.deepEqual(result.measurements.map((measurement) => measurement.sleepStages), [
    { unspecified: 4, core: 3, deep: 0, rem: 0, awake: 0, inBed: 0 },
    { unspecified: 4, core: 0, deep: 4, rem: 0, awake: 0, inBed: 0 },
  ]);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(parseSyncPayload(result), result);
  assert.deepEqual(parseMobileSyncPayload({ ...upload([segment()]), sleepReport: { ...report([segment()]), days: 1 } }),
    parseMobileSyncPayload(upload([segment()])));
});

test("noon-crossing intervals are split and overlaps unioned within each reporting day", () => {
  const result = parseMobileSyncPayload({ ...base(), sleepReport: { ...report([
    segment(1, "2026-11-08T10:00:00+08:00", "2026-11-08T14:00:00+08:00"),
    segment(3, "2026-11-08T11:00:00+08:00", "2026-11-08T13:00:00+08:00"),
    segment(5, "2026-11-08T09:00:00+08:00", "2026-11-08T12:00:00+08:00"),
  ]), days: 2 } });
  assert.deepEqual(result.measurements.map((measurement) => [measurementDay(measurement), measurement.value]), [
    ["2026-11-08", 3], ["2026-11-09", 2],
  ]);
  assert.deepEqual(result.measurements.map((measurement) => measurement.sleepStages), [
    { unspecified: 1, core: 0, deep: 0, rem: 2, awake: 0, inBed: 0 },
    { unspecified: 1, core: 1, deep: 0, rem: 0, awake: 0, inBed: 0 },
  ]);
  assert.equal(result.measurements[0].endDate, result.measurements[1].startDate);
});

test("a full 30-day import computes each day's stages independently", () => {
  const segments = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(Date.parse("2026-11-09T12:00:00Z") - index * 86400000).toISOString().slice(0, 10);
    return [
      segment(1, `${day}T00:00:00+08:00`, `${day}T06:00:00+08:00`),
      segment(3, `${day}T00:00:00+08:00`, `${day}T02:00:00+08:00`),
      segment(4, `${day}T02:00:00+08:00`, `${day}T03:00:00+08:00`),
      segment(5, `${day}T03:00:00+08:00`, `${day}T06:00:00+08:00`),
      segment(2, `${day}T06:00:00+08:00`, `${day}T06:30:00+08:00`),
      segment(0, `${day}T00:00:00+08:00`, `${day}T07:00:00+08:00`),
    ];
  }).flat();
  const result = parseMobileSyncPayload({ ...base(), sleepReport: { ...report(segments), days: 30 } });
  assert.equal(result.measurements.length, 30);
  assert.equal(measurementDay(result.measurements[0]), "2026-10-11");
  assert.equal(measurementDay(result.measurements.at(-1)!), "2026-11-09");
  for (const row of result.measurements) {
    assert.equal(row.value, 6);
    assert.deepEqual(row.sleepStages, { unspecified: 0, core: 2, deep: 1, rem: 3, awake: 0.5, inBed: 7 });
  }
});

test("missing and awake-only dates remain absent, and only the last day is clipped at export", () => {
  const result = parseMobileSyncPayload({ ...base(), exportedAt: "2026-11-09T06:00:00+08:00", sleepReport: { ...report([
    segment(1),
    segment(1, "2026-11-06T23:00:00+08:00", "2026-11-07T07:00:00+08:00"),
    segment(0, "2026-11-07T22:00:00+08:00", "2026-11-08T08:00:00+08:00"),
    segment(2, "2026-11-07T23:00:00+08:00", "2026-11-08T07:00:00+08:00"),
  ]), days: 4 } });
  assert.deepEqual(result.measurements.map((measurement) => [measurementDay(measurement), measurement.value]), [
    ["2026-11-07", 8], ["2026-11-09", 7],
  ]);
  assert.equal(result.measurements[0].endDate, "2026-11-07T04:00:00.000Z");
  assert.equal(result.measurements[1].endDate, "2026-11-08T22:00:00.000Z");
  invalid({ ...base(), exportedAt: "2026-11-08T23:00:00+08:00", sleepReport: { ...report(), days: 2 } }, "sleepReport.day");
});

test("reporting ranges follow calendar days across leap days and year boundaries", () => {
  for (const [day, previous, start, end] of [
    ["2024-03-01", "2024-02-29", "2024-02-28T23:00:00+08:00", "2024-02-29T07:00:00+08:00"],
    ["2026-01-01", "2025-12-31", "2025-12-30T23:00:00+08:00", "2025-12-31T07:00:00+08:00"],
  ]) {
    const result = parseMobileSyncPayload({ ...base(), exportedAt: `${day}T14:00:00+08:00`, sleepReport: {
      ...report([segment(1, start, end)]), day, days: 2,
    } });
    assert.deepEqual(result.measurements.map((measurement) => [measurementDay(measurement), measurement.value]), [[previous, 8]]);
  }
});

test("historical Shanghai DST boundaries use local noon rather than fixed 24-hour windows", () => {
  const spring = parseMobileSyncPayload({ ...base(), exportedAt: "1991-04-15T14:00:00+09:00", sleepReport: {
    ...report([segment(1, "1991-04-13T12:00:00+08:00", "1991-04-14T12:00:00+09:00")]), day: "1991-04-15", days: 2,
  } });
  assert.equal(spring.measurements[0].value, 23);
  assert.equal(measurementDay(spring.measurements[0]), "1991-04-14");
  const fall = parseMobileSyncPayload({ ...base(), exportedAt: "1991-09-16T14:00:00+08:00", sleepReport: {
    ...report([segment(1, "1991-09-14T23:00:00+09:00", "1991-09-15T07:00:00+08:00")]), day: "1991-09-16", days: 2,
  } });
  assert.equal(fall.measurements[0].value, 9);
  assert.equal(fall.measurements[0].startDate, "1991-09-14T03:00:00.000Z");
  assert.equal(fall.measurements[0].endDate, "1991-09-15T04:00:00.000Z");
  invalid({ ...base(), exportedAt: "1991-09-16T14:00:00+08:00", sleepReport: {
    ...report([segment(1, "1991-09-14T12:00:00+09:00", "1991-09-15T12:00:00+08:00")]), day: "1991-09-16", days: 2,
  } }, "measurements[0].value");
});

test("multi-day ranges reject invalid counts, unsupported dates and conflicting totals", () => {
  for (const days of [undefined, null, "2", 0, -1, 1.5, MAX_SLEEP_DAYS + 1, NaN, Infinity]) {
    invalid({ ...base(), sleepReport: { ...report(), days } }, "sleepReport.days");
  }
  assert.deepEqual(parseMobileSyncPayload({ ...base(), sleepReport: { ...report(), days: MAX_SLEEP_DAYS } }).measurements, []);
  invalid({ ...base(), sleepReport: { ...report(), day: "1970-01-02", days: 2 } }, "sleepReport.day");
  assert.deepEqual(parseMobileSyncPayload({ ...base(), sleepReport: { ...report(), day: "1970-01-02", days: 1 } }).measurements, []);
  const previous = {
    id: "previous-sleep", metric: "sleep", value: 7, unit: "hours", aggregation: "daily", source: "watch",
    startDate: "2026-11-07T23:00:00+08:00", endDate: "2026-11-08T06:00:00+08:00",
  };
  invalid({ ...base(), measurements: [previous], sleepReport: { ...report(), days: 2 } }, "sleepReport");
  invalid({ ...base(), measurements: [previous], sleepReport: { ...report([segment(0)]), days: 2 } }, "sleepReport");
});

test("multiple sleep days still obey the combined measurement limit and validate out-of-range samples", () => {
  const measurements = Array.from({ length: 1000 }, (_, index) => ({
    id: `weight-${index}`, metric: "weight", value: 70, unit: "kg", aggregation: "sample",
    startDate: "2026-11-09T07:00:00+08:00",
  }));
  invalid({ ...upload([segment()]), measurements, sleepReport: { ...report([segment()]), days: 2 } }, "measurements");
  invalid({ ...base(), sleepReport: { ...report([
    segment("unknown", "2026-10-01T23:00:00+08:00", "2026-10-02T07:00:00+08:00"),
  ]), days: 2 } }, ".state");
});
