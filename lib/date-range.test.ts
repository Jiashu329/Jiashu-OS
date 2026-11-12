import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {DATE_RANGE_CLIENT_SCRIPT,DateRangeError,isCalendarDay,parseDateRangeQuery,resolveDateRange} from './date-range.ts';
const NOW=Date.parse('2026-11-11T16:01:00Z');
test('custom ranges count real Shanghai calendar days inclusively, including leap days and one-day ranges',()=>{
  assert.deepEqual(resolveDateRange({from:'2024-02-28',to:'2024-03-01'},NOW),{from:'2024-02-28',to:'2024-03-01',days:3,today:'2026-11-12'});
  assert.equal(resolveDateRange({from:'2026-11-12',to:'2026-11-12'},NOW).days,1);
  assert.equal(resolveDateRange({days:7},NOW).from,'2026-11-06');
  assert.equal(isCalendarDay('2024-02-29'),true);assert.equal(isCalendarDay('2025-02-29'),false);
});
test('invalid, reversed, future, ambiguous, duplicated and over-budget date ranges are rejected',()=>{
  for(const value of [{from:'2026-02-30',to:'2026-03-02'},{from:'2026-11-12'},{to:'2026-11-12'},
    {from:'2026-11-12',to:'2026-11-11'},{from:'2026-11-12',to:'2026-11-13'},{from:'2024-01-01',to:'2024-12-31'},
    {from:'1969-12-31',to:'1970-01-01'},{from:'2026-01-01',to:'2026-01-02',days:7},{days:'007'}])assert.throws(()=>resolveDateRange(value,NOW),DateRangeError);
  assert.throws(()=>parseDateRangeQuery(new URLSearchParams('from=2026-01-01&from=2026-01-02&to=2026-01-03'),NOW),DateRangeError);
});
test('client range validation matches the canonical typed rules without server closures',()=>{
  const client=runInNewContext(DATE_RANGE_CLIENT_SCRIPT+'\n({resolveDateRange,isCalendarDay})',{Date}) as {resolveDateRange:typeof resolveDateRange;isCalendarDay:typeof isCalendarDay};
  for(const value of [{days:360},{from:'2024-02-29',to:'2024-02-29'},{from:'2026-01-01',to:'2026-03-01'}])assert.deepEqual(JSON.parse(JSON.stringify(client.resolveDateRange(value,NOW))),resolveDateRange(value,NOW));
  assert.throws(()=>client.resolveDateRange({from:'2025-02-29',to:'2025-03-01'},NOW));
});
