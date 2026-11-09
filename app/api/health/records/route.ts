import { listHealthRecords, writeHealthRecord } from '../../../../db/health-records-store';
import { parseHealthRecordCreate, parseHealthRecordsQuery } from '../../../../lib/health-records';
import { shanghaiDay } from '../../../../lib/health';
import { apiUser, json, unauthenticated } from '../../_shared';
import { guardRecordWrite, invalidRecordRequestId, recordBody, recordRequestId, recordsDatabase, recordsError } from './_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const now = Date.now();
    const selection = parseHealthRecordsQuery(new URL(request.url).searchParams, now);
    const result = await listHealthRecords(recordsDatabase(), user.userId, selection);
    return json({ ...result, today: shanghaiDay(new Date(now).toISOString()) });
  } catch (error) { return recordsError(error); }
}

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = guardRecordWrite(request);
  if (guard) return guard;
  const requestId = recordRequestId(request);
  if (!requestId) return invalidRecordRequestId();
  try {
    const command = parseHealthRecordCreate(await recordBody(request), requestId);
    return json(await writeHealthRecord(recordsDatabase(), user.userId, command, requestId), 201);
  } catch (error) { return recordsError(error); }
}
