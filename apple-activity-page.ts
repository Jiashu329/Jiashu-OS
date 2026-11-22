import { APP_SIDEBAR_CSS, renderAppSidebar } from './lib/app-sidebar.ts';
import { APP_THEME_CSS } from './lib/app-theme.ts';
import { APPLE_ACTIVITY_SCRIPT } from './lib/apple-activity-ui.ts';
import { APP_BRAND_HEAD } from './lib/branding.ts';
import { DATE_RANGE_PRESETS } from './lib/date-range.ts';
import { renderPageHeadingCopy } from './lib/page-heading.ts';

const vitalCards = [
  { id: 'heart-rate', title: '日均心率', unit: '次/分' },
  { id: 'resting-heart-rate', title: '静息心率', unit: '次/分' },
  { id: 'oxygen', title: '血氧', unit: '%' },
];

const APPLE_ACTIVITY_CSS = String.raw`
:root{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--bg);font-synthesis:none}
*{box-sizing:border-box}body{margin:0}button,input{font:inherit;color:inherit}button:not(:disabled){cursor:pointer}a{color:inherit;text-decoration:none}[hidden]{display:none!important}
:where(a,button,input,summary):focus-visible{outline:2px solid var(--primary);outline-offset:3px}
.activity-filter,.activity-panel{background:var(--paper);border:1px solid var(--line);border-radius:var(--panel-radius)}
.activity-filter{margin-bottom:18px;padding:14px 18px}
.activity-filter-controls{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px}
.activity-presets{display:flex;flex-wrap:wrap;gap:6px}.activity-range{margin:0;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.activity-filter details{margin-top:10px}.activity-filter summary{width:fit-content;padding:3px 0;color:var(--primary-hover);cursor:pointer;font-size:12px}
.activity-filter form{display:flex;align-items:end;flex-wrap:wrap;gap:10px;margin-top:10px}.activity-filter label{display:grid;gap:5px;color:var(--muted);font-size:12px}
.activity-filter input{min-height:40px;padding:6px 9px;border:1px solid var(--line);border-radius:var(--control-radius);background:var(--paper);color:var(--ink)}
.activity-filter .btn,.activity-status .btn{min-width:55px;padding:6px 10px;border:1px solid var(--line);background:var(--paper);color:var(--primary-hover);white-space:nowrap}
.activity-filter .btn:hover,.activity-status .btn:hover{background:var(--hover)}.activity-presets .btn[aria-pressed=true]{background:var(--soft);border-color:var(--primary);font-weight:600}
.activity-error{margin:8px 0 0;color:var(--red)}.activity-status{display:flex;align-items:center;gap:10px 16px;flex-wrap:wrap;margin:0 0 18px;padding:14px 18px;border:1px solid var(--line);border-radius:var(--control-radius);background:var(--paper);color:var(--muted)}
.activity-status p{margin:0}.activity-status[data-error=true]{color:var(--red)}
.activity-vitals{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0 0 16px}
.activity-card{--vital-color:#9e4561;min-width:0;padding:17px 18px;background:var(--paper);border:1px solid var(--line);border-radius:var(--panel-radius)}
.activity-card:nth-child(2){--vital-color:#6854a0}.activity-card:nth-child(3){--vital-color:#22658a}
.activity-card h2{margin:0;font-size:14px;font-weight:600}.activity-value{display:flex;align-items:baseline;gap:5px;margin:7px 0 2px;font-variant-numeric:tabular-nums}
.activity-value strong{color:var(--vital-color);font-size:28px;font-weight:650;letter-spacing:-.045em}.activity-value strong[data-empty]{color:var(--muted);font-size:15px;letter-spacing:normal}
.activity-value span,.activity-latest{color:var(--muted);font-size:12px}.activity-latest{margin:0;min-height:2.8em}
.activity-plot{height:56px;margin-top:8px;border-bottom:1px solid var(--line);display:flex;align-items:end;gap:var(--plot-gap,0px)}.activity-plot span{flex:1;min-width:0;height:var(--relative-height,0);background:var(--vital-color);border-radius:2px 2px 0 0;opacity:.76}.activity-plot span:last-child{opacity:1}
.activity-plot-label{margin:5px 0 0;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.activity-panel{min-width:0;margin-top:16px}.activity-panel header{padding:16px 18px 12px}.activity-panel h2{margin:0;font-size:15px;font-weight:650}.activity-panel p{margin:4px 0 0;color:var(--muted);font-size:12px}
.activity-empty{padding:8px 18px 18px}.activity-table{overflow-x:auto}.activity-table table{width:100%;min-width:510px;border-collapse:collapse;font-size:13px;text-align:left}
.activity-table :is(th,td){padding:10px 18px;border-top:1px solid var(--line);white-space:nowrap}.activity-table thead th{background:var(--subtle);color:var(--muted);font-size:12px}
.activity-table tbody th{font-variant-numeric:tabular-nums}.activity-table td small{display:block;color:var(--muted);font-size:11px}
.activity-workouts{list-style:none;margin:0;padding:0}.activity-workout{display:grid;grid-template-columns:minmax(150px,1fr) minmax(0,2fr);align-items:center;gap:12px 20px;padding:13px 18px;border-top:1px solid var(--line)}
.activity-workout strong{display:block;font-size:14px;font-weight:600}.activity-workout time{color:var(--muted);font-size:12px}.activity-workout dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 14px;margin:0}
.activity-workout dt{color:var(--muted);font-size:11px}.activity-workout dd{margin:3px 0 0;font-variant-numeric:tabular-nums}
.activity-help{margin:12px 0 0;color:var(--muted);font-size:12px}
@media(max-width:720px){.activity-vitals{gap:8px}.activity-card{padding:13px 11px}.activity-value strong{font-size:24px}.activity-workout{grid-template-columns:1fr}.activity-filter .btn{min-width:0}}
@media(max-width:570px){.activity-table table{min-width:0;table-layout:fixed;font-size:12px}.activity-table :is(th,td){padding:8px;white-space:normal;overflow-wrap:anywhere;vertical-align:top}.activity-table tbody th{white-space:nowrap;font-size:11px}.activity-table thead th:nth-child(1){width:26%}.activity-table thead th:nth-child(2){width:27%}.activity-table thead th:nth-child(3){width:19%}}
@media(max-width:400px){.activity-card{padding:12px 9px}.activity-value{flex-wrap:wrap;gap:0 3px}.activity-value strong{font-size:22px}.activity-value span,.activity-latest{font-size:11px}.activity-plot{height:38px}.activity-filter,.activity-panel header{padding-inline:13px}}
`;

export function renderAppleActivityPage(): string {
  const heading = renderPageHeadingCopy({ section: '健康', title: '心率、血氧与训练', description: '查看从 iPhone 苹果健康同步的每日读数和单次训练。' });
  return `<!doctype html><html lang="zh-CN"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    ${APP_BRAND_HEAD}<meta name="theme-color" content="#f3f5f8"><title>Jiashu OS · 心率、血氧与训练</title>
    <style>${APP_THEME_CSS}${APPLE_ACTIVITY_CSS}${APP_SIDEBAR_CSS}</style>
  </head><body><div class="app">${renderAppSidebar('health')}
    <main id="activity-page">
      <header class="page-heading">${heading}</header>
      <section class="activity-filter" aria-label="日期范围">
        <div class="activity-filter-controls">
          <div class="activity-presets" role="group" aria-label="最近天数">${DATE_RANGE_PRESETS.map(days => `<button type="button" class="btn" data-activity-days="${days}" aria-pressed="${days === 30}">${days} 天</button>`).join('')}</div>
          <p id="activity-range" class="activity-range"></p>
        </div>
        <details id="activity-custom-range"><summary>自定日期</summary>
          <form id="activity-range-form" aria-describedby="activity-range-error">
            <label>开始日期<input id="activity-from" type="date" min="1970-01-01" required></label>
            <label>结束日期<input id="activity-to" type="date" min="1970-01-01" required></label>
            <button type="submit" class="btn">应用日期</button>
          </form>
          <p id="activity-range-error" class="activity-error" role="alert" hidden></p>
        </details>
      </section>
      <div id="activity-status" class="activity-status" role="status"><p id="activity-status-text">正在读取苹果健康记录…</p><button id="activity-retry" type="button" class="btn" hidden>重试</button></div>
      <div id="activity-results" aria-busy="true" hidden>
        <div class="activity-vitals">
          ${vitalCards.map(({ id, title, unit }) => `<section class="activity-card" aria-labelledby="activity-${id}-title">
            <h2 id="activity-${id}-title">${title}</h2>
            <div class="activity-value"><strong id="activity-${id}-value" data-empty>暂无记录</strong><span id="activity-${id}-unit" hidden>${unit}</span></div>
            <p class="activity-latest" id="activity-${id}-latest"></p>
            <div id="activity-${id}-plot-group" hidden>
              <div class="activity-plot" id="activity-${id}-plot" aria-hidden="true"></div>
              <p class="activity-plot-label" id="activity-${id}-plot-label"></p>
            </div>
          </section>`).join('')}
        </div>
        <section class="activity-panel" aria-labelledby="activity-vitals-title">
          <header><h2 id="activity-vitals-title">每日读数</h2><p>心率单位为次/分，血氧单位为百分比。</p></header>
          <p id="activity-vitals-empty" class="activity-empty" hidden>这段日期暂无读数。</p>
          <div id="activity-vitals-table" class="activity-table" role="region" aria-label="每日读数明细" tabindex="0" hidden>
            <table><thead><tr><th scope="col">日期</th><th scope="col">平均心率及范围</th><th scope="col">静息心率</th><th scope="col">血氧平均值及范围</th></tr></thead><tbody id="activity-vital-rows"></tbody></table>
          </div>
        </section>
        <section class="activity-panel" aria-labelledby="activity-workouts-title">
          <header><h2 id="activity-workouts-title">训练记录</h2><p id="activity-workout-count" hidden></p></header>
          <p id="activity-workouts-empty" class="activity-empty" hidden>这段日期暂无训练记录。</p>
          <ul id="activity-workout-list" class="activity-workouts" hidden></ul>
        </section>
        <p id="activity-help" class="activity-help" hidden>可在 iPhone 的 Jiashu OS「同步中心」核对苹果健康授权和同步状态。</p>
      </div>
    </main>
  </div><script type="module">${APPLE_ACTIVITY_SCRIPT}</script></body></html>`;
}
