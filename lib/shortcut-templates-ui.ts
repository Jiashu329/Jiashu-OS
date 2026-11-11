import { CLIENT_REQUEST_SCRIPT } from './client-request.ts';

/** All browser dependencies are literal source, independent of minifier names. */
export const SHORTCUT_TEMPLATE_SCRIPT = String.raw`<script>(()=>{
${CLIENT_REQUEST_SCRIPT}
const $=(id)=>document.getElementById(id);
const labels={steps:'步数',active_energy:'活动热量',sleep:'睡眠',weight:'体重',lean_body_mass:'去脂体重'};
const metrics=$('template-check').dataset.metrics.split(',');
let startedAt=null,busy=false,arrived=false;
function message(text,error=false){$('template-status').textContent=text;$('template-status').classList.toggle('error',error);}
async function start(){
  if(busy)return;busy=true;startedAt=null;arrived=false;
  $('template-start').disabled=true;$('template-check-now').disabled=true;$('template-confirm').checked=false;$('template-confirm').disabled=true;$('template-results').replaceChildren();
  message('正在取得服务器核对起点，请稍候…');
  try{const data=await requestJSON('/api/health/import');const time=Date.parse(data.checkedAt);
    if(!Number.isFinite(time))throw new Error('未取得服务器核对时间，请刷新后重试。');
    startedAt=time;message('本次核对已开始。请在 iPhone 运行快捷指令，返回后点击“检查新同步”。');
  }catch(error){message(error.message||'暂时无法开始核对，请重试。',true);}
  finally{busy=false;$('template-start').disabled=false;$('template-check-now').disabled=startedAt===null;}
}
$('template-start').addEventListener('click',start);
$('template-confirm').addEventListener('change',()=>{
  if(arrived&&$('template-confirm').checked)message('本次核对完成：网站已收到相应指标，你已确认来源、日期和数值。此结果不代表后续每次同步都会成功。');
  else if(arrived)message('相应指标已收到，请对照 iPhone 健康 App 核对来源、日期和数值。');
});
$('template-check-now').addEventListener('click',async()=>{
  if(busy||startedAt===null)return;busy=true;$('template-check-now').disabled=true;$('template-start').disabled=true;
  message('正在读取本次核对开始后的同步回执…');
  try{
    const data=await requestJSON('/api/health/import');const attempts=Array.isArray(data.attempts)?data.attempts:[];
    const results=metrics.map((metric)=>{
      let latest=null;
      for(const item of attempts){
        const time=Date.parse(item.createdAt);
        if(!Number.isFinite(time)||time<=startedAt||!['success','unchanged','duplicate'].includes(item.status)||!Array.isArray(item.summary?.metrics)||(metric==='sleep'&&item.summary.emptySleepWindow))continue;
        const row=item.summary.metrics.find((value)=>value.metric===metric);
        if(!row||!Number.isSafeInteger(row.received)||row.received<=0)continue;
        const changed=item.status==='success'&&Number.isSafeInteger(row.added)&&Number.isSafeInteger(row.updated)&&row.added+row.updated>0;
        const same=['success','unchanged'].includes(item.status)&&Number.isSafeInteger(row.unchanged)&&row.unchanged>0&&row.older===0;
        const valid=changed||same;
        if(latest?.valid&&!valid)continue;
        if(latest&&time<latest.time&&latest.valid===valid)continue;
        latest={row,time,changed,valid};
      }
      return {metric,latest};
    });
    $('template-results').replaceChildren();
    for(const {metric,latest}of results){
      const li=document.createElement('li');
      li.textContent=labels[metric]+'：'+(!latest?'尚未收到本次核对开始后的有效记录':latest.valid?(latest.changed?'已更新':'已收到相同数据，数值未变化')+' · '+(latest.row.from||'未知日期')+' 至 '+(latest.row.to||'未知日期')+' · 来源 '+(Array.isArray(latest.row.sources)&&latest.row.sources.length?latest.row.sources.join('、'):'未提供'):'收到重复／旧批次，尚不能确认这次读取');
      $('template-results').append(li);
    }
    arrived=results.every((result)=>result.latest?.valid);$('template-confirm').disabled=!arrived;$('template-confirm').checked=false;
    message(arrived?'网站已收到所选模板的全部指标（可能数值未变化），请对照 iPhone 核对数值、日期与来源。':'尚未收到全部指标的本次有效记录。请检查读取权限、日期范围、实际来源和同步地址；已有历史与重复批次不会算作本次验收。');
  }catch(error){message(error.message||'暂时无法读取同步结果，请重试。',true);}
  finally{busy=false;$('template-check-now').disabled=false;$('template-start').disabled=false;}
});
})();</script>`;
