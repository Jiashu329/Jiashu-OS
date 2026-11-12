import type { HealthMetric } from './health.ts';
import { resolveDateRange, type DateRange } from './date-range.ts';

export const ASSISTANT_DAYS = [7, 30, 90, 180, 360] as const;
export type AssistantDays = typeof ASSISTANT_DAYS[number];
export const ASSISTANT_METRICS: readonly HealthMetric[] = ['weight', 'lean_body_mass', 'steps', 'active_energy', 'sleep'];
export interface AssistantScope { metrics: HealthMetric[]; includeNutrition: boolean; includeGoals: boolean }
export class AssistantScopeError extends Error { constructor(message = '请选择有效的指标、资料和日期范围。') { super(message); this.name = 'AssistantScopeError'; } }
export function parseAssistantDays(value: unknown): AssistantDays {
  if (typeof value !== 'number' || !(ASSISTANT_DAYS as readonly number[]).includes(value)) throw new AssistantScopeError('请选择近 7、30、90、180 或 360 天。');
  return value as AssistantDays;
}
export function parseAssistantScope(value?: unknown): AssistantScope {
  if (value === undefined) return { metrics: [...ASSISTANT_METRICS], includeNutrition: true, includeGoals: false };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssistantScopeError();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['metrics', 'includeNutrition', 'includeGoals'].includes(key)) || !Array.isArray(input.metrics)
    || input.metrics.some((metric) => typeof metric !== 'string' || !ASSISTANT_METRICS.includes(metric as HealthMetric))
    || new Set(input.metrics).size !== input.metrics.length || typeof input.includeNutrition !== 'boolean' || typeof input.includeGoals !== 'boolean') throw new AssistantScopeError();
  const selected = input.metrics as string[];
  const metrics = ASSISTANT_METRICS.filter((metric) => selected.includes(metric));
  if (!metrics.length && !input.includeNutrition) throw new AssistantScopeError('请至少选择一项健康指标或饮食摘要。');
  return { metrics, includeNutrition: input.includeNutrition, includeGoals: input.includeGoals };
}
export function parseAssistantRange(input:{days?:unknown;from?:unknown;to?:unknown},now=Date.now()):DateRange {
  try{return resolveDateRange(input,now,7);}catch(error){throw new AssistantScopeError(error instanceof Error?error.message:undefined);}
}
export function assistantScopeKey(days: number, scope: AssistantScope,range?:{from:string;to:string}): string { return JSON.stringify([days, scope.metrics, scope.includeNutrition, scope.includeGoals,...(range?[range.from,range.to]:[])]); }
