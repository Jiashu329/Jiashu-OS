import { APP_LOGO_SRC } from './branding.ts';
import { renderHealthAssistantWidget } from './health-assistant-widget.ts';
import { APP_PAGE_UX_CSS } from './app-page-ux.ts';
import { renderAppNavigationScript } from './app-navigation-ui.ts';
import { DRAFT_GUARD_SCRIPT } from './draft-guard.ts';

type AppPage = 'home' | 'health' | 'nutrition' | 'finance' | 'sync';

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
@media(max-width:760px){.sidebar{flex-direction:column;align-items:stretch;gap:14px;padding:16px}.brand{align-self:flex-start}.nav{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px}.nav-link{justify-content:center;gap:6px;padding:10px 6px}}
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
@media(max-width:760px){.sidebar{grid-template-columns:32px minmax(0,1fr);gap:7px 10px;padding:8px 14px}.brand{align-self:center;min-height:32px}.brand>span{display:none}.brand-mark{width:32px;height:32px;border-radius:8px}.nav{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));min-width:0;gap:2px}.nav-link{min-width:0;width:100%;flex-direction:column;justify-content:center;min-height:48px;gap:4px;padding:5px 2px;font-size:11px}.nav-link svg{width:17px;height:17px;flex-basis:17px}.sidebar-context{padding-top:6px}.context-link{min-height:31px;padding:5px 9px}}
@media(max-width:380px){.sidebar{padding-inline:10px;gap:6px}.nav-link{gap:3px;padding:5px 1px;font-size:11px}.nav-link svg{width:16px;height:16px;flex-basis:16px}}
${APP_PAGE_UX_CSS}
`;

const contextNavigation = {
  health: { label: '健康管理', links: [['/health', '趋势总览'], ['/health/weight-plan', '体重计划'], ['/health/review', '每周回顾'], ['/health/records', '记录管理'], ['/settings/ai', 'AI 设置']] },
  finance: { label: '财务管理', links: [['/finance', '账户总览'], ['/finance/balances', '核对余额'], ['/finance/goals', '资金目标'], ['/finance/runway', '应急储备'], ['/finance/review', '月度回顾']] },
  sync: { label: '数据连接', links: [['/sync', '连接与导入'], ['/sync/templates', '快捷指令模板'], ['/data', '数据备份'], ['/sync-guide', '同步指南'], ['/connect-steps', '步数与活动'], ['/connect-sleep', '睡眠同步'], ['/connect-weight', '体重同步']] },
} as const;

const navigation = [
  { page: 'home', label: '首页', href: '/', shape: '<path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7"/>' },
  { page: 'health', label: '健康', href: '/health', shape: '<path d="M20.5 12.5 12 21l-8.5-8.5a5.5 5.5 0 0 1 7.8-7.8l.7.7.7-.7a5.5 5.5 0 0 1 7.8 7.8Z"/>' },
  { page: 'nutrition', label: '饮食', href: '/health/nutrition', shape: '<path d="M4 3v5a3 3 0 0 0 6 0V3M7 3v18M20 21V3c-4 2-5 7-5 10h5"/>' },
  { page: 'finance', label: '财务', href: '/finance', shape: '<path d="M19 7V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v12H5a3 3 0 0 1-3-3V6M20 12h-5a2 2 0 0 0 0 4h5M16 14h.01"/>' },
  { page: 'sync', label: '同步', href: '/sync', shape: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>' },
] as const;

export function renderAppSidebar(activePage: AppPage, options: { healthNavigation?: boolean } = {}): string {
  const items = navigation.map(({ page, label, href, shape }) => {
    const active = page === activePage;
    const attributes = `class="nav-link${active ? ' active' : ''}" data-navigation-page="${page}"${active ? ' aria-current="page"' : ''}`;
    const icon = `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${shape}</svg>`;
    if (options.healthNavigation && (page === 'health' || page === 'sync')) {
      return `<button type="button" ${attributes} data-page="${page === 'health' ? 'overview' : 'sync'}">${icon}${label}</button>`;
    }
    return `<a ${attributes} href="${href}">${icon}${label}</a>`;
  }).join('');

  const sections = Object.entries(contextNavigation).map(([group, section]) => `<section class="sidebar-context" data-navigation-group="${group}"${activePage !== group ? ' hidden' : ''}><p class="sidebar-context-title">${section.label}</p><nav class="context-nav" aria-label="${section.label}">${section.links.map(([href, label]) => `<a class="context-link" href="${href}" data-context-path="${href}">${label}</a>`).join('')}</nav></section>`).join('');
  return `<aside class="sidebar" data-app-sidebar aria-label="主导航"><a class="brand" href="/" aria-label="Jiashu OS 首页"><img class="brand-mark" src="${APP_LOGO_SRC}" width="36" height="36" alt="" aria-hidden="true" decoding="async"><span>Jiashu OS</span></a><div class="workspace-label">我的空间</div><nav class="nav" aria-label="主要页面">${items}</nav>${sections}<div class="sidebar-foot"><span class="space-avatar" aria-hidden="true">J</span><div><strong>个人管理空间</strong><small>Jiashu OS</small></div></div></aside><script>${DRAFT_GUARD_SCRIPT}</script>${renderHealthAssistantWidget()}${renderAppNavigationScript()}`;
}
