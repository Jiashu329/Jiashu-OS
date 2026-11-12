import { apiUser, json, unauthenticated } from '../_shared';

export const dynamic = 'force-dynamic';

/** Opaque identity only; local recovery never sends its content to this endpoint. */
export async function GET() {
  const user = await apiUser();
  return user ? json({ userId: user.userId }) : unauthenticated();
}
