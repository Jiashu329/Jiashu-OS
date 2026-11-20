import { APP_SIDEBAR_CSS, renderAppSidebar } from './lib/app-sidebar.ts';
import { APP_THEME_CSS } from './lib/app-theme.ts';
import { APP_BRAND_HEAD } from './lib/branding.ts';
import { renderRecipesScript } from './lib/recipes-ui.ts';

const styles = String.raw`
:root{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--bg)}
*{box-sizing:border-box}body{margin:0}[hidden]{display:none!important}a{color:var(--primary-hover)}button,input,textarea,select{font:inherit;color:inherit}
.recipes-main{width:100%;max-width:1130px;min-width:0;margin:0 auto;padding:30px 36px 52px}
.recipes-header,.recipes-dialog-header,.recipes-actions{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.recipes-header{margin-bottom:24px}.recipes-header h1{margin:0;font-size:29px;font-weight:650}.recipes-header p,.recipe-help{margin:5px 0 0;color:var(--muted);font-size:14px}
.recipe-button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:8px 14px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--primary-hover);text-decoration:none;cursor:pointer}
.recipe-button:hover:not(:disabled){background:var(--hover)}.recipe-button.primary{background:var(--primary);border-color:var(--primary);color:var(--paper)}.recipe-button.primary:hover:not(:disabled){background:var(--primary-hover)}.recipe-button:disabled{opacity:.55;cursor:default}
.recipes-panel,.recipes-pending{padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--paper);box-shadow:var(--shadow)}
.recipes-pending{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 16px;background:var(--soft);margin-bottom:16px}.recipes-pending p{margin:0}
.recipes-filter{display:grid;grid-template-columns:minmax(160px,1fr) minmax(132px,180px) auto;align-items:end;gap:12px;margin-bottom:15px}
.recipes-filter label,.recipe-field{display:grid;gap:5px;min-width:0;font-size:14px;font-weight:550}
.recipes-filter input,.recipes-filter select,.recipe-field input,.recipe-field textarea{width:100%;min-width:0;min-height:42px;border:1px solid var(--line);border-radius:8px;background:var(--paper);padding:8px 10px;font-weight:400}
.recipe-field textarea{resize:vertical}.recipe-status{margin:0 0 12px;color:var(--muted);font-size:14px}.recipe-status[data-error]{color:var(--red)}.recipe-status:empty{display:none}
.recipe-grid{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,237px),1fr));gap:12px}
.recipe-card{display:grid;align-content:start;gap:7px;width:100%;min-height:85px;padding:15px 16px;text-align:left;border:1px solid var(--line);border-radius:9px;background:var(--subtle);cursor:pointer;overflow-wrap:anywhere}
.recipe-card:hover{background:var(--hover);border-color:var(--primary)}.recipe-card strong{font-weight:650}.recipe-card small{font-size:13px;color:var(--muted)}.recipe-more{margin-top:14px}
.recipe-dialog{width:min(660px,calc(100vw - 28px));max-height:calc(100dvh - 28px);overflow:auto;padding:0;border:1px solid var(--line);border-radius:13px;color:var(--ink);background:var(--paper);box-shadow:0 22px 64px #1d273837}
.recipe-dialog::backdrop{background:#1d27385e}.recipes-dialog-header{padding:16px 20px;border-bottom:1px solid var(--line)}.recipes-dialog-header h2{font-size:21px;line-height:1.4;margin:0;overflow-wrap:anywhere}
.recipes-dialog-body{padding:17px 20px 20px}.recipes-form-fields,.recipes-import{display:grid;gap:13px}.recipes-form-fields{padding:0;border:0;margin:0;min-width:0}
.recipes-import{background:var(--subtle);padding:13px;border:1px solid var(--line);border-radius:8px}.recipes-import details[open] summary{margin-bottom:10px}.recipes-import summary{cursor:pointer;color:var(--primary-hover);font-weight:550}
.recipes-inline-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.recipes-inline-actions a{overflow-wrap:anywhere}
.recipes-import .recipe-status{margin:0}.recipes-form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.recipe-details{display:grid;gap:15px;overflow-wrap:anywhere}.recipe-details p,.recipe-details h3{margin:0}.recipe-details p{white-space:pre-wrap}.recipe-details h3{font-size:15px;margin-bottom:4px}.recipe-details .recipe-details-meta{color:var(--muted);white-space:normal}.recipe-details .recipe-button{justify-self:start}
@media(max-width:670px){.recipes-main{padding:22px 15px 38px}.recipes-header{margin-bottom:16px}.recipes-panel{padding:13px}.recipes-filter{grid-template-columns:minmax(0,1fr) auto;gap:8px}.recipes-filter label:first-child{grid-column:1/-1}.recipes-dialog-header,.recipes-dialog-body{padding-left:14px;padding-right:14px}}
`;

export function renderRecipesPage(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${APP_BRAND_HEAD}<title>Jiashu OS · 我的菜谱</title><style>${APP_THEME_CSS}${APP_SIDEBAR_CSS}${styles}</style></head>
<body><div class="app">${renderAppSidebar('recipes')}
<main class="recipes-main">
  <header class="recipes-header"><div><h1>我的菜谱</h1><p>收藏小红书和下厨房菜谱，随时查看食材和做法。</p></div>
    <button type="button" class="recipe-button primary" id="recipes-add" disabled>保存菜谱链接</button>
  </header>
  <section class="recipes-pending" id="recipes-pending" aria-label="菜谱保存待确认" hidden>
    <p id="recipes-pending-message" role="status"></p><button type="button" class="recipe-button" id="recipes-retry">继续核对原操作</button>
  </section>
  <section class="recipes-panel" aria-label="菜谱列表">
    <form class="recipes-filter" id="recipes-filter" role="search">
      <label>搜索菜谱<input type="search" id="recipes-query" maxlength="100" placeholder="菜名、食材或作者"></label>
      <label>来源<select id="recipes-source"><option value="all">全部来源</option><option value="xiaohongshu">小红书</option><option value="xiachufang">下厨房</option><option value="own">自制菜</option></select></label>
      <button type="submit" class="recipe-button">搜索</button>
    </form>
    <p id="recipes-status" class="recipe-status" role="status">正在读取菜谱…</p>
    <ul class="recipe-grid" id="recipes-list"></ul>
    <button type="button" class="recipe-button recipe-more" id="recipes-more" hidden>加载更多</button>
  </section>
</main></div>
<dialog class="recipe-dialog" id="recipe-editor" aria-labelledby="recipe-editor-title">
  <div class="recipes-dialog-header"><h2 id="recipe-editor-title">保存菜谱链接</h2><button type="button" class="recipe-button" id="recipe-cancel">取消</button></div>
  <form class="recipes-dialog-body" id="recipe-form">
    <p id="recipe-form-status" class="recipe-status" role="status"></p>
    <fieldset class="recipes-form-fields" id="recipe-fields">
      <div class="recipes-import" id="recipe-import">
        <label class="recipe-field">菜谱链接或分享文字<textarea id="recipe-source-input" rows="2" maxlength="8192" placeholder="粘贴小红书或下厨房分享链接" required></textarea></label>
        <div class="recipes-inline-actions"><button type="button" class="recipe-button" id="recipe-preview" disabled>读取原文</button>
          <a id="recipe-open-original" target="_blank" rel="noopener noreferrer" hidden>打开原文</a>
        </div>
        <p id="recipe-preview-status" class="recipe-status" role="status"></p>
        <details id="recipe-paste"><summary>粘贴原文文字</summary>
          <label class="recipe-field">菜谱原文<textarea id="recipe-original-text" rows="4" maxlength="24000"></textarea></label>
          <button type="button" class="recipe-button recipe-more" id="recipe-apply-text">带入菜谱</button>
        </details>
      </div>
      <label class="recipe-field">菜名<input id="recipe-title" maxlength="100" autocomplete="off" placeholder="可留空，保存时使用来源名称"></label>
      <label class="recipe-field">食材与用量<textarea id="recipe-ingredients" rows="3" maxlength="3000" placeholder="每项一行"></textarea></label>
      <label class="recipe-field">做法<textarea id="recipe-steps" rows="4" maxlength="6000" placeholder="每步一行"></textarea></label>
      <label class="recipe-field">份量<input id="recipe-servings" maxlength="120" autocomplete="off" placeholder="例如 2 人份"></label>
      <label class="recipe-field">备注<textarea id="recipe-note" rows="2" maxlength="1000"></textarea></label>
    </fieldset>
    <div class="recipes-form-actions"><button type="submit" class="recipe-button primary" id="recipe-save">保存</button></div>
  </form>
</dialog>
<dialog class="recipe-dialog" id="recipe-detail" aria-labelledby="recipe-detail-title">
  <div class="recipes-dialog-header"><h2 id="recipe-detail-title">菜谱详情</h2><button type="button" class="recipe-button" id="recipe-detail-close">关闭</button></div>
  <div class="recipes-dialog-body"><div id="recipe-detail-body" class="recipe-details"></div>
    <div class="recipes-form-actions"><button type="button" id="recipe-edit" class="recipe-button">编辑菜谱</button></div>
  </div>
</dialog>
<script>${renderRecipesScript()}</script>
</body></html>`;
}
