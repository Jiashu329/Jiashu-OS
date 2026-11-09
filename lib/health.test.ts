import assert from "node:assert/strict";
import test from "node:test";
import {
  HealthValidationError,
  MAX_MEASUREMENTS,
  MAX_SYNC_BYTES,
  buildHealthSummary,
  measurementDay,
  measurementKey,
  parseSyncPayload,
  shanghaiDay,
} from "./health.ts";

const step = {
  id: "steps:2026-11-08",
  metric: "steps",
  value: 8200,
  unit: "count",
  startDate: "2026-11-08T00:00:00+08:00",
  endDate: "2026-11-09T00:00:00+08:00",
  source: "selected-watch",
  aggregation: "daily",
};
const payload = (measurements: unknown[] = []) => ({
  version: 1,
  source: "apple-health-shortcuts",
  timezone: "Asia/Shanghai",
  exportedAt: "2026-11-09T10:00:00+08:00",
  measurements,
});
const invalid = (value: unknown, path?: string) => {
  assert.throws(() => parseSyncPayload(value), (error: unknown) => {
    assert.ok(error instanceof HealthValidationError);
    if (path) assert.ok(error.issues.some((issue) => issue.path.includes(path)), error.message);
    return true;
  });
};

test("empty sync preserves missingness rather than inventing zero readings", () => {
  const sync = parseSyncPayload(JSON.stringify(payload()));
  assert.equal(sync.exportedAt, "2026-11-09T02:00:00.000Z");
  const summary = buildHealthSummary(sync.measurements);
  assert.equal(summary.measurementCount, 0);
  assert.equal(summary.lastMeasurementAt, null);
  for (const metric of Object.values(summary.metrics)) {
    assert.equal(metric.latestValue, null);
    assert.deepEqual(metric.points, []);
  }
});

test("explicit zero aggregate remains real data", () => {
  const sync = parseSyncPayload(payload([{ ...step, value: 0 }]));
  assert.equal(buildHealthSummary(sync.measurements).metrics.steps.latestValue, 0);
});

test("identical retried records deduplicate, conflicting IDs fail", () => {
  const sync = parseSyncPayload(payload([step, { ...step }]));
  assert.equal(sync.measurements.length, 1);
  assert.equal(measurementKey(sync.measurements[0]), "steps:2026-11-08");
  invalid(payload([step, { ...step, value: 9000 }]), ".id");
});

test("two sources or conflicting totals for the same day are never added", () => {
  invalid(payload([step, { ...step, id: "second", source: "selected-phone" }]), ".source");
  invalid(payload([step, { ...step, id: "second", value: 1000 }]), "measurements");
  const first = parseSyncPayload(payload([step])).measurements[0];
  const revised = parseSyncPayload(payload([{ ...step, id: "revision", value: 9000 }])).measurements[0];
  assert.equal(buildHealthSummary([first, revised]).metrics.steps.latestValue, 9000);
});

test("multi-day exports round-trip when the selected daily source changes", () => {
  const sync = parseSyncPayload(payload([
    { ...step, id: "steps-phone-day-7", value: 6000, source: "selected-phone", startDate: "2026-11-07T00:00:00+08:00", endDate: "2026-11-08T00:00:00+08:00" },
    step,
  ]));
  const reimported = parseSyncPayload(JSON.stringify(sync));
  assert.deepEqual(reimported, sync);
  assert.deepEqual(reimported.measurements.map((measurement) => measurement.source), ["selected-phone", "selected-watch"]);
  assert.deepEqual(buildHealthSummary(reimported.measurements).metrics.steps.points.map(({ day, value }) => ({ day, value })), [
    { day: "2026-11-07", value: 6000 },
    { day: "2026-11-08", value: 8200 },
  ]);
  // A source change inside the same day is still ambiguous and rejected.
  invalid(payload([step, { ...step, id: "same-day-phone", source: "selected-phone" }]), ".source");
});

test("daily total identity remains stable across updated exports", () => {
  const first = parseSyncPayload(payload([step])).measurements[0];
  const second = parseSyncPayload({ ...payload([{ ...step, id: "new-export-id", value: 8500 }]), exportedAt: "2026-11-09T12:00:00+08:00" }).measurements[0];
  assert.equal(measurementKey(first), measurementKey(second));
});

test("a deduplicated daily alias ID cannot be reused for another date", () => {
  invalid(payload([
    step,
    { ...step, id: "alias" },
    { ...step, id: "alias", startDate: "2026-11-07T00:00:00+08:00", endDate: "2026-11-08T00:00:00+08:00" },
  ]), ".id");
});

test("units, bounds, finite numbers and integer steps are strict", () => {
  for (const value of [NaN, Infinity, -1, 200001, 12.5, "8200", null]) invalid(payload([{ ...step, value }]), ".value");
  invalid(payload([{ ...step, unit: "steps" }]), ".unit");
  invalid(payload([{ ...step, metric: "sleep", unit: "hours", value: 25 }]), ".value");
  invalid(payload([{ ...step, metric: "active_energy", unit: "kcal", value: 20001 }]), ".value");
  invalid(payload([{ ...step, metric: "weight", unit: "kg", value: 2, aggregation: "sample" }]), ".value");
});

test("raw samples and absent selected source are not accepted as daily totals", () => {
  invalid(payload([{ ...step, aggregation: undefined }]), ".aggregation");
  invalid(payload([{ ...step, aggregation: "sample" }]), ".aggregation");
  invalid(payload([{ ...step, source: undefined }]), ".source");
  invalid(payload([{ ...step, endDate: undefined }]), ".endDate");
});

test("impossible, timezone-less and reversed dates fail", () => {
  for (const startDate of ["2026-02-30T00:00:00+08:00", "2026-11-08", "2026-11-08T00:00:00", "2026-11-08T25:00:00Z", "2026-11-08T00:00:00+14:30"]) {
    invalid(payload([{ ...step, startDate }]), ".startDate");
  }
  invalid(payload([{ ...step, endDate: "2026-11-07T00:00:00+08:00" }]), ".endDate");
  invalid(payload([{ ...step, startDate: `${step.startDate}\n` }]), ".startDate");
  invalid(payload([{ ...step, id: `${step.id}\n` }]), ".id");
  invalid({ ...payload([step]), exportedAt: "2026-02-29T00:00:00Z" }, "exportedAt");
  invalid({ ...payload([step]), exportedAt: "2026-11-07T00:00:00Z" }, ".startDate");
  invalid(payload([{ id: "boundary", metric: "weight", unit: "kg", value: 80, startDate: "1970-01-01T00:00:00+14:00" }]), ".startDate");
});

test("step and energy daily periods cannot silently span multiple calendar days", () => {
  invalid(payload([{ ...step, endDate: "2026-11-09T01:00:00+08:00" }]), ".endDate");
  invalid(payload([{ ...step, metric: "active_energy", unit: "kcal", value: 400, endDate: "2026-11-09T01:00:00+08:00" }]), ".endDate");
  const partial = parseSyncPayload(payload([{ ...step, endDate: "2026-11-08T18:00:00+08:00" }]));
  assert.equal(measurementDay(partial.measurements[0]), "2026-11-08");
});

test("Shanghai date is used across UTC midnight and sleep belongs to its ending date", () => {
  assert.equal(shanghaiDay("2026-11-07T16:30:00Z"), "2026-11-08");
  const sleep = parseSyncPayload(payload([{
    id: "sleep:night-8", metric: "sleep", value: 7.5, unit: "hours",
    startDate: "2026-11-07T23:00:00+08:00", endDate: "2026-11-08T07:30:00+08:00",
    source: "selected-watch", aggregation: "daily",
  }])).measurements[0];
  assert.equal(measurementDay(sleep), "2026-11-08");
  assert.equal(measurementKey(sleep), "sleep:2026-11-08");
  const summary = buildHealthSummary([sleep]);
  assert.deepEqual(summary.metrics.sleep.points.map(({ day, value }) => ({ day, value })), [{ day: "2026-11-08", value: 7.5 }]);
});

test("weight samples remain individually identifiable; daily chart shows the latest sample", () => {
  const sync = parseSyncPayload(payload([
    { id: "weight-morning", metric: "weight", value: 80, unit: "kg", startDate: "2026-11-08T07:00:00+08:00" },
    { id: "weight-evening", metric: "weight", value: 80.2, unit: "kg", startDate: "2026-11-08T20:00:00+08:00" },
  ]));
  assert.notEqual(measurementKey(sync.measurements[0]), measurementKey(sync.measurements[1]));
  const summary = buildHealthSummary([...sync.measurements].reverse());
  assert.equal(summary.measurementCount, 2);
  assert.equal(summary.metrics.weight.latestValue, 80.2);
  assert.equal(summary.metrics.weight.points.length, 1);
});

test("gaps in daily observations stay gaps instead of zero-filled days", () => {
  const sync = parseSyncPayload(payload([
    { ...step, id: "day-6", startDate: "2026-11-06T00:00:00+08:00", endDate: "2026-11-07T00:00:00+08:00" },
    step,
  ]));
  assert.deepEqual(buildHealthSummary(sync.measurements).metrics.steps.points.map((point) => point.day), ["2026-11-06", "2026-11-08"]);
});

test("schema and request size limits fail predictably", () => {
  invalid("not-json");
  invalid(null);
  invalid({ ...payload(), version: 2 }, "version");
  invalid({ ...payload(), source: "unknown" }, "source");
  invalid({ ...payload(), timezone: "UTC" }, "timezone");
  invalid({ ...payload(), extra: true }, "extra");
  invalid(payload(Array.from({ length: MAX_MEASUREMENTS + 1 }, () => step)), "measurements");
  invalid(" ".repeat(MAX_SYNC_BYTES + 1));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  invalid(cyclic);
});
