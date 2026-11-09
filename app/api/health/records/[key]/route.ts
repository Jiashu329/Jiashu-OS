import { HealthRecordNotFoundError, readHealthRecord, writeHealthRecord } from '../../../../../db/health-records-store';
import { parseHealthRecordKey, parseHealthRecordPatch } from '../../../../../lib/health-records';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { guardRecordWrite, invalidRecordRequestId, recordBody, recordRequestId, recordsDatabase, recordsError } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ key: string }> }) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const key = parseHealthRecordKey((await context.params).key);
    const record = await readHealthRecord(recordsDatabase(), user.userId, key);
    if (!record) throw new HealthRecordNotFoundError();
    return json({ record });
  } catch (error) { return recordsError(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ key: string }> }) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = guardRecordWrite(request);
  if (guard) return guard;
  const requestId = recordRequestId(request);
  if (!requestId) return invalidRecordRequestId();
  try {
    const key = parseHealthRecordKey((await context.params).key);
    const record = await readHealthRecord(recordsDatabase(), user.userId, key);
    if (!record) throw new HealthRecordNotFoundError();
    const command = parseHealthRecordPatch(await recordBody(request), record);
    return json(await writeHealthRecord(recordsDatabase(), user.userId, command, requestId));
  } catch (error) { return recordsError(error); }
}
