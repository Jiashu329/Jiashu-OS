import { renderAccountSessionScript } from './account-session.ts';

/** Pin this HTML document to the identity that authorized its server render. */
export function withPageAccount(html: string, userId: string): string {
  if (!userId || userId.length > 200 || Array.from(userId).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('Invalid page identity');
  const encoded = JSON.stringify(userId).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const binding = `<script>Object.defineProperty(window,'__JIASHU_PAGE_OWNER__',{value:${encoded},writable:false,configurable:false});</script>${renderAccountSessionScript()}`;
  if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new Error('Authenticated page must have a head');
  return html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + binding);
}
