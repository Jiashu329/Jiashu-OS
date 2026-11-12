import { readHealthRange } from '../../../db/health-repository';
import { parseDateRangeQuery, DateRangeError } from '../../../lib/date-range';
import { apiUser, json, unauthenticated, unavailable } from '../_shared';
import { readWithDeadline } from '../../../lib/read-deadline';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const range=parseDateRangeQuery(new URL(request.url).searchParams);
    return json({...await readWithDeadline(readHealthRange(user.userId,range.from,range.to)),range});
  } catch (error) {
    if(error instanceof DateRangeError)return json({error:error.message,code:'INVALID_DATE_RANGE'},400);
    return unavailable(error instanceof Error && error.message === 'READ_DEADLINE_EXCEEDED' ? 'read_timeout' : 'storage_failure');
  }
}
