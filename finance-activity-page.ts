import { APP_THEME_CSS } from './lib/app-theme.ts';
import { APP_BRAND_HEAD } from './lib/branding.ts';
import { APP_SIDEBAR_CSS, renderAppSidebar } from './lib/app-sidebar.ts';
import { renderPageHeadingCopy } from './lib/page-heading.ts';
import { FINANCE_BOOKS_CSS, renderFinanceBooksControl, renderFinanceBooksScript } from './lib/finance-books-ui.ts';
import { FINANCE_ACTIVITY_CSS, FINANCE_ACTIVITY_CONTENT, renderFinanceActivityScript } from './lib/finance-activity-ui.ts';

export function renderFinanceActivityPage(actorId: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${APP_BRAND_HEAD}<title>Jiashu OS · 家庭协作动态</title><style>${APP_THEME_CSS}${APP_SIDEBAR_CSS}${FINANCE_BOOKS_CSS}${FINANCE_ACTIVITY_CSS}:root{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:var(--ink);background:var(--bg)}*{box-sizing:border-box}body{margin:0}button{font:inherit}button:focus-visible,a:focus-visible{outline:2px solid var(--primary);outline-offset:3px}</style></head><body><div class="app">${renderAppSidebar('finance')}<main id="finance-activity-page"><header class="fa-heading">${renderPageHeadingCopy({section:'家庭账本',title:'协作动态',description:'查看谁在什么时候更新了家庭账本。'})}<div class="fa-controls"><a class="fa-button" data-context-path="/finance" href="/finance?ledger=family">账户总览</a><button class="fa-button" id="finance-activity-refresh" type="button">刷新动态</button></div></header>${renderFinanceBooksControl()}${FINANCE_ACTIVITY_CONTENT}</main></div>${renderFinanceBooksScript(actorId)}${renderFinanceActivityScript()}</body></html>`;
}
