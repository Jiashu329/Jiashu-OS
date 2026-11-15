export const DOUBAN_LIBRARY_FILTERS = String.raw`<details class="db-library-filters" id="douban-filters"><summary>筛选与排序</summary><div class="db-filter-grid">
<label class="db-field"><span>我的评分</span><select class="db-control" id="douban-rating"><option value="">全部评分</option><option value="5">5 星</option><option value="4">4 星</option><option value="3">3 星</option><option value="2">2 星</option><option value="1">1 星</option><option value="unrated">未评分</option></select></label>
<label class="db-field"><span>豆瓣标记年份</span><select class="db-control" id="douban-year"><option value="">全部年份</option></select></label>
<label class="db-field"><span>排列顺序</span><select class="db-control" id="douban-sort"><option value="date-desc">标记日期从近到远</option><option value="date-asc">标记日期从远到近</option><option value="rating-desc">我的评分从高到低</option><option value="rating-asc">我的评分从低到高</option></select></label>
<label class="db-field"><span>展示范围</span><select class="db-control" id="douban-hidden"><option value="visible">未隐藏的收藏</option><option value="hidden">已隐藏的收藏</option><option value="all">包括已隐藏的收藏</option></select></label>
<label class="db-field"><span>我的标签</span><select class="db-control" id="douban-tag"><option value="">全部标签</option></select></label>
<label class="db-filter-check"><input id="douban-missing" type="checkbox"><span>只看资料待补全</span></label>
</div><p class="db-note">年份按豆瓣标记日期筛选。未提供标记日期的作品不会归入某一年。</p></details>`;

export const DOUBAN_LIBRARY_UI_CSS = String.raw`
.db-library-filters{margin:0 0 18px;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--paper)}
.db-library-filters>summary{cursor:pointer;min-height:24px;font-size:13px;color:var(--primary-hover)}
.db-filter-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:14px}
.db-filter-check{display:flex;align-items:center;gap:9px;font-size:12px;min-height:42px;align-self:end}
.db-filter-check input{width:17px;height:17px;accent-color:var(--primary)}
.db-card-missing{display:block;font-size:10px;line-height:1.7;margin-top:6px;color:var(--muted)}
.db-metadata-detail{margin-top:18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.db-metadata-detail p{flex:1 1 180px;margin:0}
.db-browser-options{display:flex;gap:12px 20px;flex-wrap:wrap;padding:12px 14px;border:1px solid var(--line);border-radius:9px;margin:14px 0}
.db-browser-options legend{font-size:12px;color:var(--muted);padding:0 5px}
.db-browser-options label{display:flex;align-items:center;gap:8px;min-height:36px;font-size:13px}
.db-browser-options input{width:18px;height:18px;accent-color:var(--primary)}
@media(max-width:700px){.db-filter-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.db-library-filters{padding:12px}.db-filter-grid .db-control{font-size:16px}}
@media(max-width:380px){.db-filter-grid{grid-template-columns:minmax(0,1fr)}}
`;
