import { apiUser, json, unauthenticated } from '../_shared';

export const dynamic = 'force-dynamic';

/** Only the currently authenticated account; local recovery sends no content here. */
export async function GET() {
  const user = await apiUser();
  return user ? json({ userId: user.userId, displayName: user.displayName, email: user.email, isOwner: user.isOwner === true }) : unauthenticated();
}
