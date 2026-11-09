import { HealthRecordNotFoundError, readHealthRecord, readHealthRecordHistory } from '../../../../../../db/health-records-store';
import { parseHealthRecordKey } from '../../../../../../lib/health-records';
import { apiUser, json, unauthenticated } from '../../../../_shared';
import { recordsDatabase, recordsError } from '../../_shared';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ key: string }> }) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const key = parseHealthRecordKey((await context.params).key);
    if (!await readHealthRecord(recordsDatabase(), user.userId, key)) throw new HealthRecordNotFoundError();
    return json({ history: await readHealthRecordHistory(recordsDatabase(), user.userId, key) });
  } catch (error) { return recordsError(error); }
}
