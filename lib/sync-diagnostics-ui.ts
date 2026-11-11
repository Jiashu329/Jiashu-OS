export function renderSyncDiagnosticsPanel(): string {
  return `<article class="panel sync-diagnostics" aria-labelledby="sync-diagnostics-title"><style>.sync-diagnostics{margin-top:18px;padding:20px}.sync-diagnostics h2{font-size:17px;margin:0 0 7px}.sync-diagnostics p{font-size:12px;line-height:1.7;color:var(--muted)}.sync-metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:14px 0}.sync-metric-card,.sync-attempt{padding:12px;border:1px solid var(--line);border-radius:var(--radius);min-width:0}.sync-metric-card strong,.sync-attempt strong{font-size:13px}.sync-attempt{margin-top:10px;overflow-wrap:anywhere}.sync-attempt p{margin:5px 0}.sync-attempt ul{margin:6px 0;padding-left:19px;font-size:12px;line-height:1.8}.sync-attempt.error{border-color:var(--red)}.sync-diagnostics summary{cursor:pointer;font-size:13px}.sync-diagnostics-head{display:flex;justify-content:space-between;gap:15px;align-items:flex-start}@media(max-width:600px){.sync-diagnostics{padding:16px}.sync-metric-grid{grid-template-columns:1fr 1fr}}</style><div class="sync-diagnostics-head"><div><h2 id="sync-diagnostics-title">同步结果与逐项核对</h2><p>一次成功只说明本次列出的指标已处理；没有列出的睡眠、体重等指标不会一起更新。日期指原始记录日期。</p></div><button type="button" class="btn small" id="refresh-sync-diagnostics">刷新结果</button></div><div id="sync-metric-status" class="sync-metric-grid" aria-live="polite"><p>读取各指标同步状态中…</p></div><details open><summary>最近同步尝试（最多30次）</summary><p>保留最近100次服务端结果；失败只保存固定原因，不保存无效正文、健康数值或连接密钥。本机格式校验失败或请求未到服务端时可能没有回执，请保留当前错误提示。原始导入版本与回退历史单独保留。</p><div id="sync-attempts" aria-live="polite"><p>读取同步结果中…</p></div></details><p id="sync-diagnostics-error" role="alert" hidden></p></article>`;
}

/** Self-contained browser source; receipt content is always text, never HTML. */
export const SYNC_DIAGNOSTICS_UI_SCRIPT = String.raw`
function renderSyncDiagnostics(data){
 const labels={steps:'步数',sleep:'睡眠',active_energy:'活动能量',weight:'体重',lean_body_mass:'去脂体重'};
 const states={success:'已更新',empty:'未收到可写入记录',unchanged:'已接收，记录未变化',duplicate:'重复批次，未重复写入',reverted:'批次已回退，未重新写入',failed:'本次未确认完成'};
 const stamp=(value)=>{const date=new Date(value);return value&&Number.isFinite(date.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date):'暂无';};
 const node=(tag,text,cls='')=>{const item=document.createElement(tag);if(text!==undefined)item.textContent=text;if(cls)item.className=cls;return item;};
 const status=document.getElementById('sync-metric-status');status.replaceChildren();
 for(const [metric,label] of Object.entries(labels)){
  const row=(Array.isArray(data.metricStatus)?data.metricStatus:[]).find((item)=>item.metric===metric);
  const card=node('div',undefined,'sync-metric-card');card.dataset.syncMetric=metric;card.append(node('strong',label),node('p','最新原始记录：'+(row?.lastRecordDate||'暂无记录')),node('p','最近接收：'+stamp(row?.lastReceivedAt)),node('p',row?.lastAttemptAt?'最近尝试：'+stamp(row.lastAttemptAt)+' · '+(states[row.lastAttemptStatus]||'待核对'):'最近100次尝试中没有该指标回执'));
  status.append(card);
 }
 const history=document.getElementById('sync-attempts');history.replaceChildren();const attempts=Array.isArray(data.attempts)?data.attempts:[];
 if(!attempts.length){history.append(node('p','暂无当前版本的同步尝试。以前的导入仍可在“最近导入与回退”中查看。'));return;}
 for(const attempt of attempts){
  const article=node('article',undefined,'sync-attempt'+(attempt.status==='failed'?' error':''));article.dataset.syncAttempt=attempt.attemptId;
  article.append(node('strong',stamp(attempt.createdAt)+' · '+(states[attempt.status]||'待核对')));
  article.append(node('p',attempt.channel==='device'?'设备：'+(attempt.deviceLabel||'未识别的连接'):'手动 JSON 导入'));
  const summary=attempt.summary;
  article.append(node('p',summary?.known?'接收 '+summary.received+' 条；本次未列出的其他指标没有更新。':'未能解析本次指标和日期，不能据此判断任何指标已更新。'));
  if(summary?.emptySleepWindow)article.append(node('p','请求的睡眠窗口 '+summary.emptySleepWindow.from+' 至 '+summary.emptySleepWindow.to+' 没有可计入的入睡记录，缺失不补零；如有窗口外记录，会另按实际日期列出。'));
  const list=node('ul');
  for(const metric of Array.isArray(summary?.metrics)?summary.metrics:[]){
   const span=metric.from?(metric.from+(metric.to&&metric.to!==metric.from?' 至 '+metric.to:'')):'无可用日期';
   const source=(Array.isArray(metric.sources)?metric.sources:[]).join('、')+(metric.sourceCount>5?'等 '+metric.sourceCount+' 个来源':'');
   const counts=attempt.status==='failed'||attempt.status==='reverted'?'本次没有确认写入':metric.received===0?'没有可计入记录，缺失不补零':'新增 '+metric.added+'，更新 '+metric.updated+'，未变化 '+metric.unchanged+'，旧批次跳过 '+metric.older;
   list.append(node('li',(labels[metric.metric]||'健康指标')+' · '+span+' · '+(source||'未注明来源')+'；'+counts+(metric.manualOverrides?'；保留 '+metric.manualOverrides+' 条手工更正／屏蔽':'')));
  }
  if(list.children.length)article.append(list);
  if(attempt.status==='empty')article.append(node('p','这次没有新增健康数据；请检查健康权限、所选来源和日期窗口。已有记录保留。'));
  if(attempt.status==='duplicate')article.append(node('p','相同批次已经处理，本次未重复写入，也不表示取得了更新日期的数据。'));
  if(attempt.status==='reverted')article.append(node('p','这份批次此前已回退，重新发送不会恢复它；需要重新导出新的批次。'));
  if(attempt.guidance)article.append(node('p',attempt.guidance));
  history.append(article);
 }
}
`;
