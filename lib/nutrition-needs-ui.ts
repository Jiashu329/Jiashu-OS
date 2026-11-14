/** Adult calorie-needs preview. Profile inputs stay in the current document only. */
export const NUTRITION_NEEDS_CSS = String.raw`
.nt-needs{margin-bottom:20px;border:1px solid var(--line,#dce3ee);border-radius:14px;background:var(--surface-soft,#f7f9fc)}
.nt-needs>summary{cursor:pointer;padding:14px 16px;font-weight:700}.nt-needs>summary span{font-size:13px;font-weight:400;color:var(--muted,#64748b);margin-left:10px}
.nt-needs-body{padding:0 16px 16px}.nt-needs-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.nt-needs-grid .nt-field{min-width:0}
.nt-needs-result{margin-top:16px;padding-top:16px;border-top:1px solid var(--line,#dce3ee)}.nt-needs-result h3{margin:0 0 12px;font-size:15px}
.nt-needs-energy,.nt-needs-macros{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0 0 12px}.nt-needs-energy div,.nt-needs-macros div{padding:10px;border:1px solid var(--line,#dce3ee);border-radius:10px;background:var(--surface,#fff)}.nt-needs-result dt{font-size:12px;color:var(--muted,#64748b)}.nt-needs-result dd{margin:5px 0 0;font-size:16px;font-weight:700;overflow-wrap:anywhere}.nt-needs-energy .nt-needs-target{border-color:var(--accent,#4966ab)}
.nt-needs-ai{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;margin:10px 0}.nt-needs-warning{color:var(--muted,#64748b);font-size:13px;line-height:1.6}.nt-needs-source{font-size:12px;line-height:1.6;color:var(--muted,#64748b)}.nt-needs-source a{color:inherit;text-decoration:underline}.nt-needs-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:flex-end;margin-top:12px}
@media(max-width:640px){.nt-needs-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.nt-needs>summary span{display:block;margin:5px 0 0}.nt-needs-energy{grid-template-columns:1fr}.nt-needs-macros{gap:6px}.nt-needs-macros div{padding:8px}.nt-needs-macros dd{font-size:14px}}
`;

export const NUTRITION_NEEDS_CONTENT = String.raw`
<details class="nt-needs" id="nutrition-needs"><summary>AI 测算每日热量与营养<span>先算基础需要，再由 AI 解读</span></summary><div class="nt-needs-body">
<form id="nutrition-needs-form" novalidate autocomplete="off" data-no-durable-draft>
<p class="nt-compact-note">根据身体资料、活动量和体重目标，估算一天的热量及三大营养素。适用于 18–80 岁一般成人；孕哺期及特殊营养需求请使用专业方案。</p>
<div class="nt-needs-grid">
<div class="nt-field"><label for="nutrition-needs-age">年龄 / 岁</label><input class="nt-control" id="nutrition-needs-age" type="number" inputmode="numeric" min="18" max="80" step="1" placeholder="18–80" autocomplete="off"></div>
<div class="nt-field"><label for="nutrition-needs-sex">生理性别（公式系数）</label><select class="nt-control" id="nutrition-needs-sex"><option value="">请选择</option><option value="male">男性系数</option><option value="female">女性系数</option></select></div>
<div class="nt-field"><label for="nutrition-needs-height">身高 / cm</label><input class="nt-control" id="nutrition-needs-height" type="number" inputmode="decimal" min="120" max="230" step="0.1" placeholder="例如 170" autocomplete="off"></div>
<div class="nt-field"><label for="nutrition-needs-weight">体重 / kg</label><input class="nt-control" id="nutrition-needs-weight" type="number" inputmode="decimal" min="30" max="250" step="0.1" placeholder="例如 65" autocomplete="off"></div>
<div class="nt-field"><label for="nutrition-needs-activity">平时活动水平</label><select class="nt-control" id="nutrition-needs-activity"><option value="">请选择</option><option value="sedentary">久坐，基本不运动</option><option value="light">轻度活动，每周运动 1–3 天</option><option value="moderate">中度活动，每周运动 3–5 天</option><option value="active">较多活动，每周运动 6–7 天</option><option value="veryActive">高强度运动或重体力劳动</option></select></div>
<div class="nt-field"><label for="nutrition-needs-goal">体重方向</label><select class="nt-control" id="nutrition-needs-goal"><option value="maintain" selected>维持体重</option><option value="lose">温和减重</option><option value="gain">温和增重</option></select></div>
</div><p class="nt-compact-note">点击测算后，上述资料及公式结果会发送给网站共享 AI 服务生成解读。本功能不保存本次身体资料。</p>
<p class="nt-form-status" id="nutrition-needs-status" role="status" aria-live="polite"></p><div class="nt-needs-actions"><button class="nt-btn" id="nutrition-needs-clear" type="button">清空资料</button><button class="nt-btn primary" id="nutrition-needs-calculate" type="submit">AI 测算每日需要</button></div>
</form>
<section class="nt-needs-result" id="nutrition-needs-result" aria-labelledby="nutrition-needs-result-title" hidden><h3 id="nutrition-needs-result-title">每日需要的参考估算</h3>
<dl class="nt-needs-energy"><div><dt>静息代谢估算</dt><dd id="nutrition-needs-bmr"></dd></div><div><dt>维持体重所需</dt><dd id="nutrition-needs-maintenance"></dd></div><div class="nt-needs-target"><dt>目标摄入热量</dt><dd id="nutrition-needs-calories"></dd></div></dl>
<dl class="nt-needs-macros"><div><dt>碳水化合物</dt><dd id="nutrition-needs-carbs"></dd></div><div><dt>蛋白质</dt><dd id="nutrition-needs-protein"></dd></div><div><dt>脂肪</dt><dd id="nutrition-needs-fat"></dd></div></dl>
<p class="nt-needs-source" id="nutrition-needs-basis"></p><p class="nt-needs-warning" id="nutrition-needs-warning"></p><p class="nt-needs-ai" id="nutrition-needs-ai"></p><p class="nt-needs-source">热量采用 Mifflin–St Jeor 常用取整公式和活动量估算；三大营养素按碳水 50%、蛋白质 20%、脂肪 30% 供能分配（4 / 4 / 9 kcal/g）。<a href="https://pubmed.ncbi.nlm.nih.gov/2305711/" target="_blank" rel="noopener noreferrer">公式来源</a> · <a href="https://nap.nationalacademies.org/catalog/10490/" target="_blank" rel="noopener noreferrer">营养素参考范围</a>。实际需要会随个体与活动变化。</p>
<p class="nt-compact-note" id="nutrition-needs-apply-status" role="status" aria-live="polite"></p><div class="nt-needs-actions"><button class="nt-btn primary" id="nutrition-needs-apply" type="button" disabled>填入每日目标</button></div></section>
</div></details>`;

/** Kept as raw JS so production minification cannot rename its shared-closure dependencies. */
export const NUTRITION_NEEDS_SCRIPT = String.raw`
function installNutritionNeeds(options){
 const node=(id)=>document.getElementById('nutrition-needs-'+id),form=node('form'),fields=['age','sex','height','weight','activity','goal'];
 if(!form)return{refresh(){}};
 const current={busy:false,sequence:0,result:null,fingerprint:null,controller:null,applied:false};
 const profile=()=>({age:Number(node('age').value),heightCm:Number(node('height').value),weightKg:Number(node('weight').value),sex:node('sex').value,activity:node('activity').value,goal:node('goal').value});
 const fingerprint=()=>JSON.stringify(fields.map((key)=>node(key).value));
 const changedAccount=()=>Boolean(window.JiashuAccountSession?.changed);
 const validTargets=(raw)=>raw&&typeof raw==='object'&&['calories','carbs','protein','fat'].every((key)=>typeof raw[key]==='string'&&/^\d+(?:\.\d)?$/.test(raw[key])&&Number(raw[key])>0&&Number(raw[key])<=20000);
 function resultValid(result){return result&&Number.isFinite(result.estimate?.bmr)&&result.estimate.bmr>0&&Number.isFinite(result.estimate.maintenanceCalories)&&result.estimate.maintenanceCalories>0&&validTargets(result.estimate.targets)&&['ready','unavailable','rateLimited'].includes(result.ai?.status)&&(result.ai.text===null||typeof result.ai.text==='string')&&(result.ai.message===null||typeof result.ai.message==='string')&&(result.ai.status!=='ready'||typeof result.ai.text==='string'&&result.ai.text.trim().length>0);}
 function blocked(){if(changedAccount())return window.JiashuAccountSession.problem||'登录账号已变化，请刷新后继续。';if(current.busy)return'正在测算，请稍候。';if(!current.result||current.fingerprint!==fingerprint())return'资料已变化，请重新测算。';return options.goalBlocked?.()||null;}
 function refresh(){const reason=blocked();node('calculate').disabled=current.busy||changedAccount();node('clear').disabled=current.busy;node('apply').disabled=Boolean(reason)||current.applied;node('apply-status').textContent=current.applied?'参考数值已填入下方目标，核对后点击“保存每日目标”才会生效。':current.result?(reason||'这只是预览。填入后仍需核对并保存每日目标。'):'';}
 function invalidate(message='资料已修改，请重新测算。'){current.sequence++;current.result=null;current.fingerprint=null;current.applied=false;node('result').hidden=true;for(const key of ['bmr','maintenance','calories','carbs','protein','fat','basis','warning','ai'])node(key).textContent='';if(message)node('status').textContent=message;refresh();}
 function clear(){for(const key of fields)node(key).value=key==='goal'?'maintain':'';invalidate('');node('status').textContent='本次资料和估算已清空。';guard?.reset();}
 const guard=window.JiashuDraftGuards?.register({form,label:'热量测算资料',durable:false,canSave:()=>false,isBusy:()=>current.busy,isBlocked:()=>current.busy,onDiscard:clear})||null;
 form.addEventListener('input',()=>invalidate());form.addEventListener('change',()=>invalidate());
 node('clear').addEventListener('click',()=>{if(!current.busy)clear();});
 form.addEventListener('submit',async(event)=>{
  event.preventDefault();if(current.busy||changedAccount())return;
  for(const key of fields)if(!node(key).value.trim()){node('status').textContent='请完整填写身体资料、活动水平和目标。';node(key).focus();return;}
  const input=profile();if(!Number.isInteger(input.age)||input.age<18||input.age>80){node('status').textContent='年龄需为 18–80 岁的整数。';node('age').focus();return;}
  if(!Number.isFinite(input.heightCm)||input.heightCm<120||input.heightCm>230||!Number.isFinite(input.weightKg)||input.weightKg<30||input.weightKg>250){node('status').textContent='请核对身高（120–230 cm）和体重（30–250 kg）。';return;}
  invalidate('正在计算参考需要，并请 AI 解读…');current.busy=true;const sequence=++current.sequence,submitted=fingerprint();current.controller=new AbortController();refresh();
  try{const result=await options.request('/api/health/nutrition/needs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:current.controller.signal,timeoutMs:65000});
   if(sequence!==current.sequence||changedAccount()||submitted!==fingerprint())return;
   if(!resultValid(result))throw new Error('测算结果格式不完整，请重试。');
   current.result=result;current.fingerprint=submitted;const estimate=result.estimate;
   node('bmr').textContent=Math.round(estimate.bmr)+' kcal';node('maintenance').textContent=Math.round(estimate.maintenanceCalories)+' kcal';
   for(const key of ['calories','carbs','protein','fat'])node(key).textContent=estimate.targets[key]+(key==='calories'?' kcal':' g');
   const percent=(value)=>(value>0?'+':'')+value+'%';
   node('basis').textContent=[estimate.activityMultiplier,estimate.goalAdjustmentPercent,estimate.effectiveAdjustmentPercent].every(Number.isFinite)?'活动系数 ×'+estimate.activityMultiplier+'；所选目标相对维持热量调整 '+percent(estimate.goalAdjustmentPercent)+'；取整及护栏后的实际调整 '+percent(estimate.effectiveAdjustmentPercent)+'。':'';
   const warnings=Array.isArray(estimate.warnings)?estimate.warnings.filter((text)=>typeof text==='string').slice(0,6):[];
   node('warning').textContent=warnings.length?warnings.join(' '):'这是公式参考值，不是实测代谢。目标按体重方向温和调整，请结合实际体重变化复核。';
   node('ai').textContent=result.ai.status==='ready'?'AI 解读：\n'+result.ai.text:(result.ai.message||'AI 解读暂时不可用，以上为公式参考估算。');
   node('result').hidden=false;node('status').textContent=result.ai.status==='ready'?'测算完成，请先查看结果与依据。':'公式估算已完成；AI 解读本次未生成。';guard?.saved();
  }catch(error){if(sequence===current.sequence&&!changedAccount()){node('status').textContent=error.message||'暂时无法测算，请保留资料重试。';guard?.failed();}}
  finally{current.busy=false;current.controller=null;refresh();}
 });
 node('apply').addEventListener('click',async()=>{
  if(blocked()||current.applied)return;const result=current.result;
  try{if(window.JiashuAccountSession?.verify)await window.JiashuAccountSession.verify();if(blocked()||current.applied||current.result!==result)return;
   const reason=options.apply(result.estimate.targets);if(reason){node('apply-status').textContent=reason;return;}current.applied=true;refresh();
  }catch(error){node('apply-status').textContent=error.message||'暂时无法核对当前账号，请稍后重试。';}
 });
 document.addEventListener('jiashu-account-changed',()=>{current.controller?.abort();invalidate(window.JiashuAccountSession?.problem||'登录账号已变化，请刷新后继续。');});
 refresh();return{refresh};
}
`;
