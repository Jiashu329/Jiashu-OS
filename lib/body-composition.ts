import { METRIC_INFO, normalizeTimestamp, shanghaiDay, type HealthMeasurement } from './health.ts';

export interface BodyCompositionPoint {
  day: string;
  /** Derived body-fat percentage, not a directly measured Apple Health sample. */
  value: number;
  measuredAt: string;
  source: string;
  weight: number;
  leanBodyMass: number;
}

export interface BodyComposition {
  points: BodyCompositionPoint[];
  latest: BodyCompositionPoint | null;
  /** Unique observations lacking an eligible counterpart, including missing source. */
  unmatchedWeightCount: number;
  unmatchedLeanCount: number;
  /** Invalid or conflicting source/time groups; these are never estimated. */
  invalidPairCount: number;
}

interface ObservationGroup {
  measuredAt: string;
  source: string | null;
  weights: Set<number>;
  leanMasses: Set<number>;
}

/**
 * Derives estimates only from exactly matching original instants and sources.
 * Independent daily rollups must never be paired: the latest weight of a day
 * may come from a different weighing than that day's latest lean mass.
 */
export function buildBodyComposition(input: readonly HealthMeasurement[]): BodyComposition {
  const groups = new Map<string, ObservationGroup>();
  for (const measurement of input) {
    if (measurement.metric !== 'weight' && measurement.metric !== 'lean_body_mass') continue;
    // The normal sync parser already validates units and dates. These guards
    // keep a corrupted or legacy observation from generating a false estimate.
    if (measurement.unit !== 'kg') continue;
    const measuredAt = normalizeTimestamp(measurement.startDate);
    if (!measuredAt) continue;
    const rawSource = measurement.source;
    const source = typeof rawSource === 'string' && rawSource.length > 0
      && rawSource.length <= 120 && rawSource.trim() === rawSource
      && !/[\u0000-\u001f\u007f]/.test(rawSource) ? rawSource : null;
    const key = JSON.stringify([source, measuredAt]);
    let group = groups.get(key);
    if (!group) {
      group = { measuredAt, source, weights: new Set(), leanMasses: new Set() };
      groups.set(key, group);
    }
    (measurement.metric === 'weight' ? group.weights : group.leanMasses).add(measurement.value);
  }

  let unmatchedWeightCount = 0;
  let unmatchedLeanCount = 0;
  let invalidPairCount = 0;
  const paired: BodyCompositionPoint[] = [];
  for (const group of groups.values()) {
    const weight = group.weights.values().next().value as number | undefined;
    const leanBodyMass = group.leanMasses.values().next().value as number | undefined;
    if (group.weights.size > 1 || group.leanMasses.size > 1
        || (weight !== undefined && (!Number.isFinite(weight) || weight < METRIC_INFO.weight.minimum || weight > METRIC_INFO.weight.maximum))
        || (leanBodyMass !== undefined && (!Number.isFinite(leanBodyMass) || leanBodyMass < METRIC_INFO.lean_body_mass.minimum || leanBodyMass > METRIC_INFO.lean_body_mass.maximum))) {
      invalidPairCount++;
      continue;
    }
    if (!group.source || weight === undefined || leanBodyMass === undefined) {
      if (weight !== undefined) unmatchedWeightCount++;
      if (leanBodyMass !== undefined) unmatchedLeanCount++;
      continue;
    }
    if (leanBodyMass > weight) {
      invalidPairCount++;
      continue;
    }
    paired.push({
      day: shanghaiDay(group.measuredAt),
      value: Math.round((weight - leanBodyMass) / weight * 100 * 1000000) / 1000000,
      measuredAt: group.measuredAt,
      source: group.source,
      weight,
      leanBodyMass,
    });
  }

  // Stable source ordering breaks equal-time ties without depending on database
  // row order. Every displayed value still comes from one valid original pair.
  paired.sort((left, right) => left.measuredAt < right.measuredAt ? -1 : left.measuredAt > right.measuredAt ? 1
    : left.source < right.source ? -1 : left.source > right.source ? 1 : 0);
  const daily = new Map<string, BodyCompositionPoint>();
  for (const point of paired) daily.set(point.day, point);
  const points = [...daily.values()].sort((left, right) => left.day.localeCompare(right.day));
  return { points, latest: points.at(-1) ?? null, unmatchedWeightCount, unmatchedLeanCount, invalidPairCount };
}
