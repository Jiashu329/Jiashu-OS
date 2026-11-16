import { renderAccountSessionScript } from './account-session.ts';

export interface PageAccountSession {
  userId: string;
  email: string;
  displayName: string;
  isOwner: boolean;
}

function scriptValue(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Pin this HTML document to the identity that authorized its server render. */
export function withPageAccount(html: string, userId: string, session?: PageAccountSession): string {
  if (!userId || userId.length > 200 || Array.from(userId).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('Invalid page identity');
  if (session && (session.userId !== userId || typeof session.email !== 'string' || typeof session.displayName !== 'string' || typeof session.isOwner !== 'boolean')) throw new Error('Invalid page session');
  // A fresh, no-store HTML response has already passed server authorization.
  // Only public identity metadata enters the document; no cookie or token does.
  const bootstrap = session ? `Object.defineProperty(window,'__JIASHU_PAGE_SESSION__',{value:Object.freeze(${scriptValue({ userId, email: session.email, displayName: session.displayName, isOwner: session.isOwner })}),writable:false,configurable:false});` : '';
  const binding = `<script>Object.defineProperty(window,'__JIASHU_PAGE_OWNER__',{value:${scriptValue(userId)},writable:false,configurable:false});${bootstrap}</script>${renderAccountSessionScript()}`;
  if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new Error('Authenticated page must have a head');
  return html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + binding);
}
