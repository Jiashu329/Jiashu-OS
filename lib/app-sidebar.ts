import { APP_LOGO_SRC } from './branding.ts';
import { renderHealthAssistantWidget } from './health-assistant-widget.ts';
import { APP_PAGE_UX_CSS } from './app-page-ux.ts';
import { renderAppNavigationScript } from './app-navigation-ui.ts';
import { DRAFT_GUARD_SCRIPT } from './draft-guard.ts';
import { DURABLE_DRAFTS_SCRIPT } from './durable-drafts.ts';
import { renderAccountIdentityScript, renderAccountRecovery } from './account-ui.ts';
import { renderAccountSessionScript } from './account-session.ts';
import { renderNotificationsBadgeScript } from './notifications-ui.ts';

type AppPage = 'home' | 'health' | 'nutrition' | 'foods' | 'recipes' | 'finance' | 'sync' | 'account' | 'notifications' | 'douban';

// Keep the shell and its breakpoints shared by every full application page.
export const APP_SIDEBAR_CSS = String.raw`
.app{min-height:100dvh;display:grid;grid-template-columns:224px minmax(0,1fr)}
.sidebar{position:sticky;top:0;height:100dvh;display:flex;flex-direction:column;padding:28px 16px 20px;background:var(--paper);border-right:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;min-height:36px;padding:0 8px;font-size:18px;line-height:1.5;font-weight:650;letter-spacing:-.3px;white-space:nowrap}
.brand-mark{display:block;flex:none;width:36px;height:36px;object-fit:cover;border-radius:9px}
.workspace-label{margin:30px 12px 10px;font-size:10px;line-height:1.5;font-weight:550;letter-spacing:1.25px;color:var(--muted)}
.nav{display:grid;gap:6px;margin:0}
.nav-link{position:relative;display:flex;align-items:center;gap:11px;width:100%;min-height:44px;margin:0;padding:11px 12px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:inherit;font-size:14px;line-height:1.5;font-weight:400;text-align:left;text-decoration:none;white-space:nowrap}
.nav-link:hover{background:var(--hover);color:var(--ink)}
.nav-link.active{background:var(--soft);color:var(--primary-hover);font-weight:600}
.nav-link.active::before{content:"";position:absolute;top:12px;bottom:12px;left:-8px;width:3px;border-radius:3px;background:var(--primary)}
.nav-link:focus-visible,.brand:focus-visible{outline:2px solid var(--green);outline-offset:3px}
.nav-link svg{display:block;flex:0 0 18px;width:18px;height:18px;pointer-events:none}
.sidebar-foot{display:flex;align-items:center;gap:10px;margin-top:auto;padding:18px 10px 0;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
.space-avatar{display:grid;place-items:center;width:30px;height:30px;flex:none;border:1px solid #d3dff4;border-radius:50%;background:var(--soft);color:var(--primary-hover);font-size:13px;font-weight:600}
.sidebar-foot strong{display:block;color:var(--ink);font-size:12px;font-weight:550}.sidebar-foot small{display:block;margin-top:2px;font-size:10px}
@media(max-width:980px){.app{grid-template-columns:1fr}.sidebar{position:static;height:auto;flex-direction:row;align-items:center;justify-content:space-between;gap:16px;padding:16px 24px;border-right:0;border-bottom:1px solid var(--line)}.brand{padding:0}.workspace-label,.sidebar-foot{display:none}.nav{display:flex;gap:4px;margin:0}.nav-link{width:auto}.nav-link.active::before{display:none}}
@media(max-width:760px){.sidebar{flex-direction:column;align-items:stretch;gap:14px;padding:16px}.brand{align-self:flex-start}.nav{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:4px}.nav-link{justify-content:center;gap:6px;padding:10px 6px}}
@media(max-width:500px){.brand{min-height:32px;font-size:17px}.brand-mark{width:32px;height:32px;border-radius:8px}.nav-link{gap:5px;padding:10px 4px;font-size:13px}}
.sidebar{overflow-y:auto;scrollbar-width:thin}
.sidebar-context{margin:26px 8px 18px;padding-top:18px;border-top:1px solid var(--line)}
.sidebar-context[hidden]{display:none!important}
.sidebar-context-title{margin:0 0 10px;padding:0 8px;color:var(--muted);font-size:11px;font-weight:500;line-height:1.6}
.context-nav{display:grid;gap:3px}
.context-link{display:flex;align-items:center;min-height:36px;padding:7px 10px;border:1px solid transparent;border-radius:7px;color:var(--muted);font-size:12px;line-height:1.6;text-decoration:none;white-space:nowrap}
.context-link:hover{background:var(--hover);color:var(--ink)}
.context-link.active{background:var(--subtle);border-color:var(--line);color:var(--primary-hover);font-weight:600}
.context-link:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
@media(max-width:980px){.app{align-content:start}.sidebar{position:sticky;top:0;z-index:30;display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px 24px;overflow:visible;padding:14px 24px 10px}.brand{grid-column:1}.nav{grid-column:2;justify-content:flex-end;align-items:center}.sidebar-context{grid-column:1/-1;min-width:0;margin:0;padding:7px 0 0;border-top:1px solid var(--line)}.sidebar-context-title{display:none}.context-nav{display:flex;gap:5px;overflow-x:auto;padding:2px;scrollbar-width:thin}.context-link{flex:none;min-height:32px;padding:5px 10px;font-size:11px}.context-link.active{background:var(--soft);border-color:transparent}}
@media(max-width:760px){.sidebar{grid-template-columns:minmax(0,1fr);gap:7px;padding:8px 14px}.brand{display:none}.nav{display:grid;grid-column:1;grid-template-columns:repeat(6,minmax(0,1fr));min-width:0;gap:2px}.nav-link{min-width:0;width:100%;flex-direction:column;justify-content:center;min-height:48px;gap:4px;padding:5px 2px;font-size:11px}.nav-link svg{width:17px;height:17px;flex-basis:17px}.sidebar-context{padding-top:6px}.sidebar-context[data-navigation-group="douban"]{display:none}.context-link{min-height:31px;padding:5px 9px}}
@media(max-width:380px){.sidebar{padding-inline:10px;gap:6px}.nav-link{gap:3px;padding:5px 1px;font-size:11px}.nav-link svg{width:16px;height:16px;flex-basis:16px}}
.sidebar-account{text-decoration:none;border-radius:var(--radius);min-width:0}.sidebar-account:hover{background:var(--hover)}.sidebar-account.active{color:var(--primary-hover)}.sidebar-account .account-copy{min-width:0;flex:1}.sidebar-account strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sidebar-account>svg{flex:none;width:14px;height:14px}.sidebar-account-retry{margin:8px 8px 0;padding:8px 10px;min-height:36px;border:1px solid var(--line);border-radius:var(--radius);background:var(--paper);color:var(--primary-hover);font:inherit;font-size:12px;cursor:pointer}.sidebar-account-retry:hover{background:var(--hover)}.sidebar-account-retry[hidden]{display:none!important}.sidebar-account:focus-visible{outline:2px solid var(--primary);outline-offset:3px}
@media(max-width:980px){.sidebar-account{display:flex;grid-column:1/-1;margin-top:0;padding:7px 8px 0;gap:8px}.sidebar-account .space-avatar{width:24px;height:24px;font-size:11px}.sidebar-account .account-copy{display:flex;align-items:baseline;gap:10px;overflow:hidden}.sidebar-account strong{font-size:11px}.sidebar-account small{flex:none;margin-top:0;font-size:10px}.sidebar-account>svg{width:12px;height:12px}.sidebar-account-retry{grid-column:1/-1;margin:0 8px;font-size:11px;min-height:32px}}
html[data-account-changed] .app>main,html[data-account-changed] dialog,html[data-account-changed] #health-chat,html[data-account-changed] [role=dialog]{visibility:hidden!important;pointer-events:none!important}
html[data-account-changed] dialog::backdrop{background:transparent!important;pointer-events:none!important}
html[data-account-verifying] .app>main,html[data-account-verifying] dialog,html[data-account-verifying] #health-chat,html[data-account-verifying] [role=dialog]{visibility:hidden!important;pointer-events:none!important}
html[data-account-verifying] dialog::backdrop{background:transparent!important;pointer-events:none!important}
.account-recovery{position:fixed;inset:0 0 0 224px;z-index:80;display:grid;place-items:center;overflow:auto;padding:24px;background:var(--bg,#f3f5f8);color:var(--ink,#1d2738);font:14px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.account-recovery[hidden]{display:none!important}.account-recovery-card{width:min(100%,440px);padding:28px;border:1px solid var(--line,#dfe5ee);border-radius:12px;background:var(--paper,#fff);box-shadow:0 2px 8px rgb(29 39 56 / 4%)}.account-recovery-brand{margin:0 0 10px;font-size:12px;font-weight:600;color:var(--primary-hover,#45639f)}.account-recovery h2{margin:0 0 12px;font-size:23px;line-height:1.5;letter-spacing:-.02em}.account-recovery p{overflow-wrap:anywhere}.account-recovery-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.account-recovery-actions button,.account-recovery-actions a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:9px 15px;border:1px solid var(--line,#dfe5ee);border-radius:8px;background:var(--paper,#fff);color:var(--primary-hover,#45639f);font:inherit;text-decoration:none;cursor:pointer}.account-recovery-actions a{background:var(--primary,#5574b5);border-color:var(--primary,#5574b5);color:#fff}.account-recovery-actions :is(button,a):focus-visible{outline:2px solid var(--primary,#5574b5);outline-offset:3px}.account-recovery-note{margin:18px 0 0;font-size:12px;color:var(--muted,#606e84)}@media(max-width:980px){.account-recovery{inset:0;padding:20px}}@media(max-width:420px){.account-recovery-card{padding:24px 20px}.account-recovery-actions :is(button,a){flex:1}}
.sidebar-notifications{display:flex;align-items:center;gap:9px;min-height:38px;padding:8px 12px;margin-top:auto;border-radius:8px;color:var(--muted);font-size:12px;text-decoration:none}.sidebar-notifications:hover,.sidebar-notifications.active{background:var(--soft);color:var(--primary-hover)}.sidebar-notifications svg{width:17px;height:17px;flex:none}.sidebar-notifications [data-notification-unread]{min-width:18px;margin-left:auto;padding:1px 5px;border-radius:12px;background:var(--primary);color:var(--paper);text-align:center;font-size:10px}.sidebar-notifications + .sidebar-account{margin-top:10px}@media(max-width:980px){.sidebar-notifications{grid-column:1/-1;min-height:30px;margin-top:0;padding:5px 8px}.sidebar-notifications + .sidebar-account{margin-top:0}}
.sidebar-utilities{margin-top:auto;display:grid;gap:3px}.sidebar-utilities .sidebar-notifications{margin-top:0}.sidebar-utilities+.sidebar-account{margin-top:10px}@media(max-width:980px){.sidebar-utilities{grid-column:1/-1;display:flex;gap:8px;margin-top:0}.sidebar-utilities .sidebar-notifications{flex:1;min-height:30px;padding:5px 8px}.sidebar-utilities+.sidebar-account{margin-top:0}}
.sidebar-tools{display:contents}
/* Compact layouts keep only primary and contextual navigation at the top. */
@media(max-width:980px){
  :root{--app-tools-height:calc(65px + env(safe-area-inset-bottom))}
  :root:has([data-account-sidebar-retry]:not([hidden])){--app-tools-height:calc(109px + env(safe-area-inset-bottom))}
  html{scroll-padding-bottom:calc(var(--app-tools-height) + 16px)}
  .app{padding-bottom:var(--app-tools-height)}
  .sidebar-tools{position:fixed;inset:auto 0 0;z-index:30;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:8px max(12px,env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));border-top:1px solid var(--line);background:var(--paper);box-shadow:0 -2px 10px rgb(29 39 56 / 4%)}
  .sidebar-tools .sidebar-utilities{display:contents}
  .sidebar-tools .sidebar-notifications,.sidebar-tools .sidebar-account{grid-column:auto;min-width:0;min-height:48px;margin:0;padding:6px 10px;border:0;font-size:12px}
  .sidebar-tools .sidebar-account{gap:8px}
  .sidebar-tools .sidebar-account.active{background:var(--soft)}
  .sidebar-tools .account-copy{display:block;overflow:hidden}
  .sidebar-tools .account-copy strong{font-size:12px}
  .sidebar-tools .account-copy small{display:block;overflow:hidden;margin-top:2px;text-overflow:ellipsis;white-space:nowrap}
  .sidebar-tools .sidebar-account-retry{grid-column:1/-1;min-height:36px;margin:0}
  body .app .check-save-panel{bottom:calc(var(--app-tools-height) + 12px)}
  body .toast{bottom:calc(var(--app-tools-height) + 16px)}
}
.account-background-status{position:fixed;right:20px;bottom:calc(88px + env(safe-area-inset-bottom));z-index:1100;display:flex;align-items:center;gap:12px;max-width:min(440px,calc(100vw - 32px));padding:12px 16px;border:1px solid var(--line,#dfe5ee);border-radius:9px;background:var(--paper,#fff);color:var(--muted,#606e84);box-shadow:0 3px 15px rgb(29 39 56 / 9%);font:12px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.account-background-status[hidden]{display:none!important}.account-background-status button{flex:none;min-height:36px;padding:5px 10px;border:1px solid var(--line,#dfe5ee);border-radius:6px;background:var(--paper,#fff);color:var(--primary-hover,#45639f);font:inherit;cursor:pointer}.account-background-status button:focus-visible{outline:2px solid var(--primary,#5574b5);outline-offset:3px}@media(max-width:760px){.account-background-status{right:16px}}
${APP_PAGE_UX_CSS}
`;

const contextNavigation = {
  health: { label: '健康管理', links: [['/health', '趋势总览'], ['/health/weight-plan', '体重计划'], ['/health/review', '每周回顾'], ['/health/records', '记录管理'], ['/settings/ai', 'AI 设置']] },
  nutrition: { label: '饮食管理', links: [['/health/nutrition', '饮食记录'], ['/health/foods', '食物库'], ['/health/nutrition/recipes', '我的菜谱']] },
  douban: { label: '书影音分类', links: [['/life/douban', '全部收藏'], ['/life/douban?kind=movie', '电影'], ['/life/douban?kind=series', '电视剧'], ['/life/douban?kind=book', '书籍'], ['/life/douban?kind=music', '音乐'], ['/life/douban?kind=screen', '待分类']] },
  finance: { label: '财务管理', links: [['/finance', '账户总览'], ['/finance/balances', '核对余额'], ['/finance/goals', '资金目标'], ['/finance/runway', '应急储备'], ['/finance/review', '月度回顾'], ['/finance/activity', '协作动态']] },
  sync: { label: '数据连接', links: [['/sync', '连接与导入'], ['/sync/templates', '快捷指令模板'], ['/data', '数据备份'], ['/sync-guide', '同步指南'], ['/connect-steps', '步数与活动'], ['/connect-sleep', '睡眠同步'], ['/connect-weight', '体重同步']] },
} as const;

const navigation = [
  { page: 'home', label: '首页', href: '/', shape: '<path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7"/>' },
  { page: 'health', label: '健康', href: '/health', shape: '<path d="M20.5 12.5 12 21l-8.5-8.5a5.5 5.5 0 0 1 7.8-7.8l.7.7.7-.7a5.5 5.5 0 0 1 7.8 7.8Z"/>' },
  { page: 'nutrition', label: '饮食', href: '/health/nutrition', shape: '<path d="M4 3v5a3 3 0 0 0 6 0V3M7 3v18M20 21V3c-4 2-5 7-5 10h5"/>' },
  { page: 'douban', label: '书影音', href: '/life/douban', shape: '<path d="M3 4h7a3 3 0 0 1 3 3v14a3 3 0 0 0-3-3H3V4Zm10 3a3 3 0 0 1 3-3h5v14h-5a3 3 0 0 0-3 3"/>' },
  { page: 'finance', label: '财务', href: '/finance', shape: '<path d="M19 7V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v12H5a3 3 0 0 1-3-3V6M20 12h-5a2 2 0 0 0 0 4h5M16 14h.01"/>' },
  { page: 'sync', label: '同步', href: '/sync', shape: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>' },
] as const;

export function renderAppSidebar(activePage: AppPage, options: { healthNavigation?: boolean; doubanKind?: string } = {}): string {
  const nutritionSubpage = activePage === 'foods' ? '/health/foods' : activePage === 'recipes' ? '/health/nutrition/recipes' : null;
  const activeGroup = nutritionSubpage ? 'nutrition' : activePage;
  const doubanKind = ['movie', 'series', 'book', 'music', 'screen'].includes(options.doubanKind ?? '') ? options.doubanKind : 'all';
  const items = navigation.map(({ page, label, href, shape }) => {
    const active = page === activeGroup;
    const attributes = `class="nav-link${active ? ' active' : ''}" data-navigation-page="${page}"${active ? ` aria-current="${nutritionSubpage ? 'true' : 'page'}"` : ''}`;
    const icon = `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${shape}</svg>`;
    if (options.healthNavigation && (page === 'health' || page === 'sync')) {
      return `<button type="button" ${attributes} data-page="${page === 'health' ? 'overview' : 'sync'}">${icon}${label}</button>`;
    }
    return `<a ${attributes} href="${href}">${icon}${label}</a>`;
  }).join('');

  const sections = Object.entries(contextNavigation).map(([group, section]) => `<section class="sidebar-context" data-navigation-group="${group}"${activeGroup !== group ? ' hidden' : ''}><p class="sidebar-context-title">${section.label}</p><nav class="context-nav" aria-label="${section.label}">${section.links.map(([href, label]) => {
    const [path, search] = href.split('?'), kind = group === 'douban' ? new URLSearchParams(search).get('kind') ?? 'all' : null;
    const active = path === nutritionSubpage || activePage === 'douban' && group === 'douban' && kind === doubanKind;
    return `<a class="context-link${active ? ' active' : ''}" href="${href}" data-context-path="${path}"${kind === null ? '' : ` data-context-kind="${kind}"`}${active ? ' aria-current="page"' : ''}>${label}</a>`;
  }).join('')}</nav></section>`).join('');
  return `${renderAccountSessionScript()}<aside class="sidebar" data-app-sidebar aria-label="主导航"><a class="brand" href="/" aria-label="Jiashu OS 首页"><img class="brand-mark" src="${APP_LOGO_SRC}" width="36" height="36" alt="" aria-hidden="true" decoding="async"><span>Jiashu OS</span></a><div class="workspace-label">我的空间</div><nav class="nav" aria-label="主要页面">${items}</nav>${sections}<div class="sidebar-tools" role="group" aria-label="消息与账户"><div class="sidebar-utilities"><a class="sidebar-notifications${activePage === 'notifications' ? ' active' : ''}" href="/notifications" data-context-path="/notifications"${activePage === 'notifications' ? ' aria-current="page"' : ''}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>消息中心<span data-notification-unread hidden>0</span></a></div><a class="sidebar-foot sidebar-account${activePage === 'account' ? ' active' : ''}" href="/account" aria-label="查看当前账户与切换登录"${activePage === 'account' ? ' aria-current="page"' : ''}><span class="space-avatar" data-current-account-avatar aria-hidden="true">我</span><div class="account-copy"><strong data-current-account-name>当前账户</strong><small data-current-account-hint>账户与切换登录</small></div><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m9 5 7 7-7 7"/></svg></a><button class="sidebar-account-retry" type="button" data-account-retry data-account-sidebar-retry hidden>重新确认账户</button></div></aside>${renderAccountRecovery()}<script>${DURABLE_DRAFTS_SCRIPT}${DRAFT_GUARD_SCRIPT}</script>${renderHealthAssistantWidget()}${renderAppNavigationScript()}${renderAccountIdentityScript()}${renderNotificationsBadgeScript()}`;
}
