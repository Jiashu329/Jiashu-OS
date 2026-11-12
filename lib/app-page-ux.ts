/** Shared page rhythm; existing page-specific data, tables and forms stay intact. */
export const APP_PAGE_UX_CSS = String.raw`
body .app>main:not(.sync-guide-main){width:100%;min-width:0;max-width:1440px;margin-inline:auto;padding:34px clamp(24px,3.2vw,48px) 88px}
body .app>main :is(.heading,.page-heading,.hr-heading,.nt-heading,.weekly-heading,.wp-heading,.check-heading,.fg-heading,.fr-heading,.runway-heading,.rw-heading,.review-heading,.review-page-heading,.ais-heading){align-items:flex-start;gap:18px;margin-bottom:26px}
body .app>main h1{font-size:28px;font-weight:650;line-height:1.35;letter-spacing:-.035em}
.page-heading-copy{min-width:0;max-width:760px}
.page-heading-copy h1{margin:5px 0 0}
.page-heading-copy .page-eyebrow,.page-eyebrow{display:block;color:var(--primary-hover);font-size:11px;font-weight:600;line-height:1.6;letter-spacing:.04em}
.page-heading-copy .page-description,.page-description{max-width:680px;margin:8px 0 0;color:var(--muted);font-size:13px;line-height:1.85;overflow-wrap:anywhere}
body .app>main :is(.heading-actions,.heading-action,.hr-actions,.nt-actions,.fg-actions,.fr-actions,.runway-actions,.rw-actions,.review-actions,.check-actions){display:flex;align-items:center;flex-wrap:wrap;gap:8px}
body .app :is(.btn,.hr-btn,.nt-btn,.weekly-btn,.wp-btn,.check-btn,.fg-btn,.fr-btn,.runway-btn,.rw-btn,.review-btn,.ais-btn){min-height:40px;border-radius:var(--control-radius);font-size:13px;line-height:1.5;transition:background-color .15s,border-color .15s}
body .app :is(input,select,textarea){scroll-margin-top:140px}
body .app :is(.hr-control,.nt-control,.wp-control,.fg-control,.fr-control,.runway-control,.rw-control,.review-control,.ais-control){min-height:42px;border-radius:var(--control-radius)}
body .app>main :is(.panel,.hr-filter,.weekly-panel,.wp-panel,.fg-panel,.fr-panel,.runway-panel,.rw-panel,.review-panel,.ais-panel){border-radius:var(--panel-radius)}
body .app>main :is(.metric-card,.stat-card,.ledger-card,.priority-card,.weekly-card){border-radius:var(--panel-radius)}
body .app>main :is(.metric-card,.ledger-card){transition:border-color .15s,box-shadow .15s,background-color .15s}
body .app>main :is(.metric-card,.ledger-card):hover{border-color:#c5d1e4;box-shadow:0 4px 14px rgb(29 39 56 / 5%)}
body .app>main :is(.status,.ha-status,.hr-status,.nt-status,.weekly-status,.wp-status,.check-status,.fg-status,.fr-status,.runway-status,.review-status,.ais-status){border-radius:var(--control-radius);line-height:1.8}
body dialog{border-radius:var(--panel-radius)}
body dialog::backdrop{background:rgb(23 35 56 / 28%)}
body dialog :is(.control,.hr-control,.nt-control,.wp-control,.fg-control,.rw-control,.ais-control){min-height:42px;border-radius:var(--control-radius)}
body .app>main table th{font-weight:550}
body .app>main table td{font-variant-numeric:tabular-nums}
body .app>main :is(.table-wrap,.table-scroll,.weekly-table-scroll,.history-scroll){overscroll-behavior-inline:contain;scrollbar-width:thin}
@media(max-width:980px){body .app>main:not(.sync-guide-main){padding:28px 24px 84px}}
@media(max-width:600px){body dialog :is(input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),select,textarea){font-size:16px}body .app>main:not(.sync-guide-main){padding:24px 16px 88px}body .app>main h1{font-size:25px}body .app>main :is(.heading,.page-heading,.hr-heading,.nt-heading,.weekly-heading,.wp-heading,.check-heading,.fg-heading,.fr-heading,.runway-heading,.rw-heading,.review-heading,.review-page-heading,.ais-heading){gap:14px;margin-bottom:22px}.page-heading-copy .page-description,.page-description{font-size:12px;line-height:1.8}body .app>main :is(.heading-actions,.heading-action,.hr-actions,.nt-actions,.fg-actions,.fr-actions,.runway-actions,.rw-actions,.review-actions,.check-actions){width:100%;justify-content:flex-start}body .app :is(.hr-control,.nt-control,.wp-control,.fg-control,.fr-control,.runway-control,.rw-control,.review-control,.ais-control){font-size:16px}body .app :is(.btn,.hr-btn,.nt-btn,.weekly-btn,.wp-btn,.check-btn,.fg-btn,.fr-btn,.runway-btn,.rw-btn,.review-btn,.ais-btn){min-height:42px}}
@media(prefers-reduced-motion:reduce){body .app *{scroll-behavior:auto!important;transition:none!important}}
`;
