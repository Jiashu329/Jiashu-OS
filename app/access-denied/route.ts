import { chatGPTSignInPath, chatGPTSignOutPath, getChatGPTIdentity } from '../chatgpt-auth';
import { APP_BRAND_HEAD } from '../../lib/branding';

export const dynamic = 'force-dynamic';
export async function GET() {
  const identity = await getChatGPTIdentity();
  const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${APP_BRAND_HEAD}<title>使用权限 · Jiashu OS</title><style>body{margin:0;background:#f3f5f8;color:#1d2738;font:15px/1.8 system-ui,sans-serif}main{max-width:520px;margin:12vh auto;padding:28px;border:1px solid #dfe5ee;border-radius:12px;background:white}h1{font-size:24px}p{overflow-wrap:anywhere}a{display:inline-block;margin:10px 18px 0 0;color:#4267a8}@media(max-width:600px){main{margin:48px 16px;padding:24px}}</style></head><body><main><h1>${identity ? '当前账号尚未获得使用权限' : '请先登录'}</h1>${identity ? `<p>当前登录邮箱：<strong>${escape(identity.email)}</strong></p><p>请联系网站管理员，将这个邮箱加入使用名单。未获准或已停用的账号无法查看或修改业务数据。</p><a target="_top" href="${chatGPTSignOutPath('/account?signedOut=1')}">退出并更换账号</a>` : `<p>每个人使用自己的账号登录，健康、饮食和财务记录独立保存。</p><a target="_top" href="${chatGPTSignInPath('/')}">使用 ChatGPT 登录</a>`}</main></body></html>`, { status: 403, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } });
}
