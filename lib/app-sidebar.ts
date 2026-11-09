import { APP_LOGO_SRC } from './branding.ts';

type AppPage = 'home' | 'health' | 'finance' | 'sync';

// Keep the shell and its breakpoints shared by every full application page.
export const APP_SIDEBAR_CSS = String.raw`
.app{min-height:100dvh;display:grid;grid-template-columns:208px minmax(0,1fr)}
.sidebar{position:sticky;top:0;height:100dvh;display:flex;flex-direction:column;padding:24px 16px;background:var(--paper);border-right:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;min-height:36px;padding:0 8px;font-size:18px;line-height:1.5;font-weight:650;white-space:nowrap}
.brand-mark{display:block;flex:none;width:36px;height:36px;object-fit:cover;border-radius:9px}
.nav{display:grid;gap:4px;margin:28px 0 0}
.nav-link{display:flex;align-items:center;gap:10px;width:100%;min-height:42px;margin:0;padding:10px 12px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:inherit;font-size:14px;line-height:1.5;font-weight:400;text-align:left;text-decoration:none;white-space:nowrap}
.nav-link:hover{background:#f2f4f6}
.nav-link.active{background:var(--soft);color:var(--green);font-weight:600}
.nav-link:focus-visible,.brand:focus-visible{outline:2px solid var(--green);outline-offset:3px}
.nav-link svg{display:block;flex:0 0 18px;width:18px;height:18px;pointer-events:none}
@media(max-width:980px){.app{grid-template-columns:1fr}.sidebar{position:static;height:auto;flex-direction:row;align-items:center;justify-content:space-between;gap:16px;padding:16px 24px;border-right:0;border-bottom:1px solid var(--line)}.brand{padding:0}.nav{display:flex;gap:4px;margin:0}.nav-link{width:auto}}
@media(max-width:760px){.sidebar{flex-direction:column;align-items:stretch;gap:14px;padding:16px}.brand{align-self:flex-start}.nav{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}.nav-link{justify-content:center;gap:6px;padding:10px 6px}}
@media(max-width:500px){.brand{min-height:32px;font-size:17px}.brand-mark{width:32px;height:32px;border-radius:8px}.nav-link{gap:5px;padding:10px 4px;font-size:13px}}
`;

const navigation = [
  { page: 'home', label: '首页', href: '/', shape: '<path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7"/>' },
  { page: 'health', label: '健康', href: '/health', shape: '<path d="M20.5 12.5 12 21l-8.5-8.5a5.5 5.5 0 0 1 7.8-7.8l.7.7.7-.7a5.5 5.5 0 0 1 7.8 7.8Z"/>' },
  { page: 'finance', label: '财务', href: '/finance', shape: '<path d="M19 7V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v12H5a3 3 0 0 1-3-3V6M20 12h-5a2 2 0 0 0 0 4h5M16 14h.01"/>' },
  { page: 'sync', label: '同步', href: '/sync', shape: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>' },
] as const;

export function renderAppSidebar(activePage: AppPage, options: { healthNavigation?: boolean } = {}): string {
  const items = navigation.map(({ page, label, href, shape }) => {
    const active = page === activePage;
    const attributes = `class="nav-link${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}`;
    const icon = `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${shape}</svg>`;
    if (options.healthNavigation && (page === 'health' || page === 'sync')) {
      return `<button type="button" ${attributes} data-page="${page === 'health' ? 'overview' : 'sync'}">${icon}${label}</button>`;
    }
    return `<a ${attributes} href="${href}">${icon}${label}</a>`;
  }).join('');

  return `<aside class="sidebar" aria-label="主导航"><a class="brand" href="/" aria-label="Jiashu OS 首页"><img class="brand-mark" src="${APP_LOGO_SRC}" width="36" height="36" alt="" aria-hidden="true" decoding="async"><span>Jiashu OS</span></a><nav class="nav">${items}</nav></aside>`;
}
