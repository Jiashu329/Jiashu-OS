import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { accountAccess } from './account-access';
import { identityFromHeaders } from '../lib/account-identity';
import type { SiteIdentity } from '../lib/account-identity';
import { safeAccountRetryPath } from '../lib/account-retry';

export type ChatGPTUser = SiteIdentity & { isOwner: boolean };
const SIGN_IN_PATH = '/signin-with-chatgpt';
const SIGN_OUT_PATH = '/signout-with-chatgpt';
const CALLBACK_PATH = '/callback';

/** Preserve service failures separately from a signed-out or denied identity. */
export async function getChatGPTAccess() {
  return accountAccess(await headers());
}

export async function getChatGPTUser(returnToOnUnavailable?: string): Promise<ChatGPTUser | null> {
  const access = await getChatGPTAccess();
  if (!access.allowed && access.reason === 'unavailable' && returnToOnUnavailable !== undefined) {
    redirect('/service-unavailable?returnTo=' + encodeURIComponent(safeAccountRetryPath(returnToOnUnavailable)));
  }
  return access.allowed && access.identity ? { ...access.identity, isOwner: access.isOwner } : null;
}

/** Identity display on the denial screen does not grant access to any business data. */
export async function getChatGPTIdentity(): Promise<SiteIdentity | null> {
  return identityFromHeaders(await headers());
}

export async function requireChatGPTUser(returnTo: string): Promise<ChatGPTUser> {
  const access = await getChatGPTAccess();
  if (access.allowed && access.identity) return { ...access.identity, isOwner: access.isOwner };
  if (access.reason === 'unavailable') redirect('/service-unavailable?returnTo=' + encodeURIComponent(safeAccountRetryPath(returnTo)));
  if (access.identity) redirect('/access-denied');
  redirect(chatGPTSignInPath(returnTo));
}

export function chatGPTSignInPath(returnTo: string): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export function chatGPTSignOutPath(returnTo = '/'): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_OUT_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//')) return '/';

  let url: URL;
  try {
    url = new URL(value, 'https://app.local');
  } catch {
    return '/';
  }
  if (url.origin !== 'https://app.local') return '/';
  if (isReservedAuthPath(url.pathname)) return '/';

  return `${url.pathname}${url.search}${url.hash}`;
}

function isReservedAuthPath(pathname: string): boolean {
  return (
    pathname === SIGN_IN_PATH ||
    pathname === SIGN_OUT_PATH ||
    pathname === CALLBACK_PATH
  );
}
