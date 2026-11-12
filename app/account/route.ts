import { chatGPTSignInPath, chatGPTSignOutPath, getChatGPTUser, requireChatGPTUser } from '../chatgpt-auth';
import { renderAccountPage } from '../../account-page';
import { withPageAccount } from '../../lib/page-account';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // A public sign-out receipt has no account data and avoids immediately signing
  // the same ChatGPT account back in before the user has a chance to switch.
  const signedOut = new URL(request.url).searchParams.get('signedOut') === '1';
  const user = signedOut ? await getChatGPTUser() : await requireChatGPTUser('/account');
  const html = renderAccountPage({
    signInHref: chatGPTSignInPath('/account'),
    signOutHref: chatGPTSignOutPath('/account?signedOut=1'),
  });
  return new Response(user ? withPageAccount(html, user.userId) : html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } });
}
