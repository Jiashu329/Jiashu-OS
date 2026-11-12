export const DATE_RANGE_PRESETS = [7, 30, 90, 180, 360] as const;
export const MAX_DATE_RANGE_DAYS = 360;
export interface DateRange { from: string; to: string; days: number; today: string }
export class DateRangeError extends Error { constructor(message = '请选择有效的起止日期。') { super(message); this.name = 'DateRangeError'; } }
/** Real calendar dates, including leap years, rather than Date's overflow normalization. */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:19[7-9]\d|20\d\d|2100)-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + 'T12:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
export function resolveDateRange(input: { days?: unknown; from?: unknown; to?: unknown }, now = Date.now(), defaultDays = 90): DateRange {
  if (!Number.isFinite(now)) throw new DateRangeError();
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  if (!isCalendarDay(today)) throw new DateRangeError('当前日期不在支持范围内。');
  const custom = input.from !== undefined || input.to !== undefined;
  let from: string, to: string;
  if (custom) {
    if (input.days !== undefined) throw new DateRangeError('自定日期和天数范围不能同时提交。');
    if (!isCalendarDay(input.from) || !isCalendarDay(input.to)) throw new DateRangeError('请完整填写有效的开始和结束日期。');
    from = input.from; to = input.to;
  } else {
    const value = input.days === undefined ? defaultDays : input.days;
    if (!['number','string'].includes(typeof value) || !DATE_RANGE_PRESETS.some((days) => String(days) === String(value))) throw new DateRangeError('请选择 7、30、90、180 或 360 天，或自定日期。');
    to = today; from = new Date(Date.parse(today + 'T12:00:00Z') - (Number(value) - 1) * 86400000).toISOString().slice(0, 10);
  }
  const days = Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000) + 1;
  if (!isCalendarDay(from) || from > to || to > today || days < 1 || days > MAX_DATE_RANGE_DAYS) throw new DateRangeError('日期需从早到晚、不得晚于今天，最多选择 360 天（包含起止日期）。');
  return { from, to, days, today };
}
export function parseDateRangeQuery(query: URLSearchParams, now = Date.now(), defaultDays = 90): DateRange {
  if (['days','from','to'].some((key) => query.getAll(key).length > 1)) throw new DateRangeError('时间范围不能重复提交。');
  return resolveDateRange(Object.fromEntries(['days','from','to'].filter((key) => query.has(key)).map((key) => [key, query.get(key)])), now, defaultDays);
}

/** Literal client implementation avoids server bundler closure renaming. Verified against typed rules. */
export const DATE_RANGE_CLIENT_SCRIPT = String.raw`
function isCalendarDay(value){if(typeof value!=='string'||!/^(?:19[7-9]\d|20\d\d|2100)-\d{2}-\d{2}$/.test(value))return false;const time=Date.parse(value+'T12:00:00Z');return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value;}
function resolveDateRange(input,now=Date.now(),defaultDays=90){if(!Number.isFinite(now))throw new Error('请选择有效的起止日期。');const today=new Date(now+8*3600000).toISOString().slice(0,10);if(!isCalendarDay(today))throw new Error('当前日期不在支持范围内。');const custom=input.from!==undefined||input.to!==undefined;let from,to;if(custom){if(input.days!==undefined)throw new Error('自定日期和天数范围不能同时提交。');if(!isCalendarDay(input.from)||!isCalendarDay(input.to))throw new Error('请完整填写有效的开始和结束日期。');from=input.from;to=input.to;}else{const value=input.days===undefined?defaultDays:input.days;if(!['number','string'].includes(typeof value)||![7,30,90,180,360].some((days)=>String(days)===String(value)))throw new Error('请选择 7、30、90、180 或 360 天，或自定日期。');to=today;from=new Date(Date.parse(today+'T12:00:00Z')-(Number(value)-1)*86400000).toISOString().slice(0,10);}const days=Math.round((Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000)+1;if(!isCalendarDay(from)||from>to||to>today||days<1||days>360)throw new Error('日期需从早到晚、不得晚于今天，最多选择 360 天（包含起止日期）。');return {from,to,days,today};}
`;
