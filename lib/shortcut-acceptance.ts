import type { SHORTCUT_TEMPLATES } from './shortcut-templates.ts';

export const SHORTCUT_GUIDE_VERSION = '2026-11-12';
export const SHORTCUT_DEVICE_CHECKS = {
  installed: '已在 iPhone 安装并打开这份模板',
  permissions: '已逐项检查健康读取权限',
  connection: '已核对本站地址、当前连接和实际数据来源',
  values: '已对照健康 App 核对日期、来源和数值',
  repeatedRun: '已再次运行，确认没有重复新增或错误覆盖',
} as const;
type Template = (typeof SHORTCUT_TEMPLATES)[number];
interface AcceptanceInput {
  metrics: string[];
  checks: Record<keyof typeof SHORTCUT_DEVICE_CHECKS, boolean>;
  iosVersion: string;
  serverStartedAt: string;
  serverConfirmed: boolean;
  phoneConfirmed: boolean;
  automation: 'not-configured' | 'configured';
}

/** Self-contained so the same validation can run in a browser without imports. */
export function buildShortcutAcceptance(input: AcceptanceInput, template: { id: string; url: string; metrics: readonly string[]; guideVersion: string }, now: number = Date.now()) {
  const allowedChecks = ['installed','permissions','connection','values','repeatedRun'];
  if (!input || !template || !['steps','active_energy','sleep','weight'].includes(template.id)
    || !/^\d{4}-\d{2}-\d{2}$/.test(template.guideVersion)) throw new Error('模板版本信息无效，请刷新页面。');
  const url = new URL(template.url);
  if (url.protocol !== 'https:' || url.hostname !== 'www.icloud.com' || !/^\/shortcuts\/[a-f0-9]{32}$/.test(url.pathname)
    || url.search || url.hash) throw new Error('模板链接无效，请刷新页面。');
  const startedAt = Date.parse(input.serverStartedAt);
  if (input.serverConfirmed !== true || input.phoneConfirmed !== true || !Number.isFinite(startedAt)
    || startedAt > now + 5 * 60000 || now - startedAt > 86400000) throw new Error('请先完成本次网站回执和手机数值核对；超过24小时请重新开始。');
  if (!input.checks || Object.keys(input.checks).length !== allowedChecks.length || allowedChecks.some((key) => input.checks[key as keyof typeof input.checks] !== true)) throw new Error('请先逐项完成 iPhone 检查。');
  if (!Array.isArray(input.metrics) || !input.metrics.length || new Set(input.metrics).size !== input.metrics.length
    || input.metrics.some((metric) => !template.metrics.includes(metric))) throw new Error('本次核对指标无效，请重新开始核对。');
  const iosVersion = typeof input.iosVersion === 'string' ? input.iosVersion.trim() : '';
  if (iosVersion && !/^(?:iOS\s*)?\d{1,2}(?:\.\d{1,2}){0,2}$/.test(iosVersion)) throw new Error('iOS 版本请填写如 18.6，未知可留空。');
  if (!['not-configured','configured'].includes(input.automation)) throw new Error('请选择个人自动化状态。');
  return {
    kind: 'jiashu-shortcut-device-acceptance', version: 1, templateId: template.id,
    templateUrl: url.href, guideVersion: template.guideVersion, templateContentVerifiedByWebsite: false,
    recordedAt: new Date(now).toISOString(), serverStartedAt: input.serverStartedAt,
    metrics: [...input.metrics], iosVersion: iosVersion || null, checks: { ...input.checks }, automation: input.automation,
    verification: 'user-confirmed-on-device',
    limitation: '本报告记录用户在 iPhone 上的手动核对，不代表网站已检查模板内容，也不保证后续每次自动同步成功。',
  };
}

export function renderShortcutAcceptancePanel(template: Template): string {
  const configuration = JSON.stringify({ id: template.id, url: template.url, metrics: template.metrics, guideVersion: SHORTCUT_GUIDE_VERSION });
  return String.raw`<details class="template-acceptance" id="template-device-acceptance"><summary>iPhone 验收清单与报告 <small>指南 ${SHORTCUT_GUIDE_VERSION} · 真机核对后填写</small></summary><p>网站不会自动声称模板已在 iPhone 验收。按上方流程取得新回执后，在手机逐项检查，再导出仅含核对元数据的报告。</p>${Object.entries(SHORTCUT_DEVICE_CHECKS).map(([key,label])=>`<label><input type="checkbox" data-device-check="${key}"><span>${label}</span></label>`).join('')}<label for="template-ios-version">iOS 版本（可选）<input id="template-ios-version" inputmode="decimal" maxlength="12" placeholder="如 18.6"></label><label for="template-automation">个人自动化<select id="template-automation"><option value="not-configured">尚未配置／仅手动运行</option><option value="configured">已配置并核对个人自动化</option></select></label><p>自动化建议：在快捷指令的“自动化”中创建每日定时运行，按系统版本核对“立即运行／运行前询问”，再检查一次新的服务器回执。没有收到新回执时，先排查手机的联网、健康权限、日期范围与当前连接；网站不能代替 iOS 在后台读取健康数据。</p><button class="template-btn" id="template-save-acceptance" type="button" disabled>导出本次验收报告</button><p id="template-acceptance-status" role="status" aria-live="polite">尚未完成真机清单，不会生成已通过报告。</p><p>报告不含健康数值、设备连接密钥或登录信息；只在你点击时生成下载，不上传服务器。</p></details><script>(()=>{const config=${configuration};const build=${buildShortcutAcceptance.toString()};const $=(id)=>document.getElementById(id),fields=[...document.querySelectorAll('[data-device-check]')];function ready(){return !$('template-confirm').disabled&&$('template-confirm').checked&&fields.every((field)=>field.checked);}function refresh(){$('template-save-acceptance').disabled=!ready();}document.addEventListener('change',()=>queueMicrotask(refresh));$('template-start').addEventListener('click',()=>queueMicrotask(refresh));$('template-save-acceptance').addEventListener('click',()=>{try{if(!ready())throw new Error('请先完成本次回执、手机确认和真机清单。');const report=build({metrics:[...document.querySelectorAll('[data-check-metric]')].filter((field)=>field.checked).map((field)=>field.dataset.checkMetric),checks:Object.fromEntries(fields.map((field)=>[field.dataset.deviceCheck,field.checked])),iosVersion:$('template-ios-version').value,automation:$('template-automation').value,serverStartedAt:$('template-check').dataset.acceptanceStartedAt||'',serverConfirmed:!$('template-confirm').disabled,phoneConfirmed:$('template-confirm').checked},config);const blob=new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='jiashu-shortcut-'+config.id+'-acceptance.json';document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);$('template-acceptance-status').textContent='已生成本次用户手动验收报告；报告不保证未来自动同步。';}catch(error){$('template-acceptance-status').textContent=error.message||'报告未生成，请重新核对。';}});refresh();})();</script>`;
}
