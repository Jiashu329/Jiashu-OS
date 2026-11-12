import { exportHealth } from '../../../../db/health-repository';
import { apiUser, json, unauthenticated, unavailable } from '../../_shared';
import { parseDateRangeQuery, DateRangeError } from '../../../../lib/date-range';
import { readWithDeadline } from '../../../../lib/read-deadline';

export const dynamic = 'force-dynamic';

export async function GET(request:Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const range=parseDateRangeQuery(new URL(request.url).searchParams);
    return json(await readWithDeadline(exportHealth(user.userId,range)), 200, {
      'Content-Disposition': 'attachment; filename="jiashu-health-'+range.from+'_'+range.to+'.json"',
      'X-Export-Range-Days': String(range.days),
      'X-Export-Range-From':range.from,
      'X-Export-Range-To':range.to,
    });
  } catch(error) {
    if(error instanceof DateRangeError)return json({error:error.message,code:'INVALID_DATE_RANGE'},400);
    return unavailable();
  }
}
