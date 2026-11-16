import { renderAssistantRangeControl, ASSISTANT_RANGE_CSS } from './assistant-range-ui.ts';
import { renderHealthAssistantWidgetScript } from './health-assistant-widget-ui.ts';

/** A page-local conversation. The shell can include this once on every signed-in page. */
export function renderHealthAssistantWidget(): string {
  return String.raw`<style>
${ASSISTANT_RANGE_CSS}
#health-chat{position:fixed;right:0;bottom:0;z-index:1000;width:0;height:0;overflow:visible;font:13px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink,#1d2738);font-synthesis:none}
#health-chat *,#health-chat *::before,#health-chat *::after{box-sizing:border-box}
#health-chat [hidden]{display:none!important}
#health-chat button,#health-chat textarea{font:inherit;color:inherit}
#health-chat button,#health-chat a{touch-action:manipulation;-webkit-tap-highlight-color:transparent}
#health-chat button{cursor:pointer}
#health-chat button:disabled{cursor:default;opacity:.48}
#health-chat button:focus-visible,#health-chat a:focus-visible,#health-chat textarea:focus-visible,#health-chat summary:focus-visible{outline:2px solid var(--primary,#5574b5);outline-offset:3px}
#health-chat svg{display:block;flex:none;pointer-events:none}
#health-chat .hc-launcher{position:fixed;right:26px;bottom:24px;z-index:1001;display:flex;align-items:center;gap:10px;min-height:50px;padding:12px 18px;border:1px solid #45639f;border-radius:28px;background:var(--primary,#5574b5);color:#fff;box-shadow:0 7px 24px rgb(49 72 118 / 21%);font-size:14px;font-weight:600}
#health-chat .hc-launcher:hover{background:var(--primary-hover,#45639f)}
#health-chat .hc-launcher svg{width:22px;height:22px}
#health-chat .hc-panel{position:fixed;right:24px;bottom:24px;z-index:1002;display:flex;flex-direction:column;width:min(440px,calc(100vw - 32px));height:min(690px,calc(100dvh - 48px));max-height:calc(100dvh - 48px);overflow:hidden;border:1px solid #d7dfec;border-radius:18px;background:var(--paper,#fff);box-shadow:0 16px 64px rgb(30 47 80 / 20%),0 2px 8px rgb(30 47 80 / 5%)}
#health-chat .hc-head{display:flex;align-items:center;gap:10px;flex:none;padding:16px 16px 14px;border-bottom:1px solid var(--line,#dfe5ee);background:var(--paper,#fff)}
#health-chat .hc-mark{display:grid;place-items:center;width:36px;height:36px;flex:none;border:1px solid #d4e0f6;border-radius:12px;background:var(--soft,#e8effb);color:var(--primary,#5574b5)}
#health-chat .hc-mark svg{width:21px;height:21px}
#health-chat .hc-title{flex:1;min-width:0}
#health-chat .hc-title h2{margin:0;font-size:15px;font-weight:650;line-height:1.6}
#health-chat .hc-title p{margin:0;color:var(--muted,#606e84);font-size:11px;line-height:1.6}
#health-chat .hc-head-actions{display:flex;align-items:center;gap:3px}
#health-chat .hc-icon-button{display:grid;place-items:center;width:30px;height:32px;padding:5px;border:0;border-radius:7px;background:transparent;color:var(--muted,#606e84)}
#health-chat .hc-icon-button:hover:not(:disabled){background:var(--hover,#f0f4fa);color:var(--ink,#1d2738)}
#health-chat .hc-icon-button svg{width:17px;height:17px}
#health-chat .hc-scope{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;flex:none;padding:10px 16px;border-bottom:1px solid var(--line,#dfe5ee);background:var(--subtle,#f8fafd)}
#health-chat .hc-scope-label{flex:1 1 100%;font-size:11px;color:var(--muted,#606e84)}
#health-chat .hc-range{display:flex;max-width:100%;gap:2px;padding:2px;border:1px solid var(--line,#dfe5ee);border-radius:7px;background:var(--paper,#fff)}
#health-chat .hc-range button{min-height:28px;padding:3px 9px;border:0;border-radius:4px;background:transparent;color:var(--muted,#606e84);font-size:11px}
#health-chat .hc-range button[aria-pressed=true]{background:var(--soft,#e8effb);color:var(--primary-hover,#45639f);font-weight:600}
#health-chat .hc-scroll{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;background:linear-gradient(180deg,#f8fafd 0,#fff 180px);padding:16px}
#health-chat .hc-welcome{padding:4px 0 18px}
#health-chat .hc-welcome h3{margin:0 0 6px;font-size:15px;font-weight:600}
#health-chat .hc-welcome p{margin:0;color:var(--muted,#606e84);font-size:12px;line-height:1.9}
#health-chat .hc-preset{display:block;margin-top:8px;font-size:11px;color:#738099}
#health-chat .hc-suggestions{display:grid;gap:7px;margin-top:14px}
#health-chat .hc-suggestions button{padding:9px 11px;border:1px solid var(--line,#dfe5ee);border-radius:9px;background:var(--paper,#fff);color:var(--muted,#606e84);font-size:12px;text-align:left;line-height:1.7}
#health-chat .hc-suggestions button:hover:not(:disabled){border-color:#c2cfe5;background:var(--soft,#e8effb);color:var(--primary-hover,#45639f)}
#health-chat .hc-status{padding:10px 11px;margin:0 0 12px;border:1px solid var(--line,#dfe5ee);border-radius:9px;background:var(--paper,#fff);color:var(--muted,#606e84);font-size:12px;line-height:1.8;overflow-wrap:anywhere}
#health-chat .hc-status.is-error{border-color:#ecd4ce;background:#fff8f6;color:var(--red,#a33131)}
#health-chat .hc-status-actions{display:flex;align-items:center;gap:12px;margin-top:4px}
#health-chat .hc-text-button,#health-chat .hc-status a{padding:0;border:0;background:none;font:inherit;color:var(--primary-hover,#45639f);text-decoration:underline;text-underline-offset:3px}
#health-chat .hc-config{margin:0 0 12px;padding:11px;border:1px solid var(--line,#dfe5ee);border-radius:9px;background:var(--soft,#e8effb);font-size:12px;line-height:1.9}
#health-chat .hc-config p{margin:0 0 5px}
#health-chat .hc-config a{color:var(--primary-hover,#45639f)}
#health-chat .hc-context{margin:0 0 16px;color:var(--muted,#606e84);font-size:11px;line-height:1.9}
#health-chat .hc-context summary{cursor:pointer;color:var(--primary-hover,#45639f)}
#health-chat .hc-context p{margin:7px 0}
#health-chat .hc-coverage{display:grid;grid-template-columns:1fr 1fr;gap:5px 12px;margin:8px 0}
#health-chat .hc-coverage div{display:flex;justify-content:space-between;gap:8px}
#health-chat .hc-coverage dt,#health-chat .hc-coverage dd{margin:0}
#health-chat .hc-source-list{margin:7px 0 0;padding-left:17px;font-size:11px;line-height:1.9;overflow-wrap:anywhere}
#health-chat .hc-source-list a{color:var(--primary-hover,#45639f);text-decoration:underline;text-underline-offset:2px}
#health-chat .hc-source-list small{display:block;color:var(--muted,#606e84);font-size:10px}
#health-chat .hc-messages{display:grid;gap:18px}
#health-chat .hc-message{min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:5px}
#health-chat .hc-message-label{font-size:10px;font-weight:500;color:var(--muted,#606e84);padding:0 2px}
#health-chat .hc-message.is-user{align-items:flex-end}
#health-chat .hc-bubble{min-width:0;max-width:100%;padding:11px 13px;border:1px solid var(--line,#dfe5ee);border-radius:3px 13px 13px;background:var(--paper,#fff);overflow-wrap:anywhere;font-size:13px;line-height:1.85}
#health-chat .is-user .hc-bubble{max-width:90%;border-color:#dbe5f6;border-radius:13px 3px 13px 13px;background:var(--soft,#e8effb);white-space:pre-wrap}
#health-chat .hc-message-tools{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;color:var(--muted,#606e84);font-size:10px;line-height:1.8}
#health-chat .hc-copy,#health-chat .hc-reveal{flex:none;min-height:25px;padding:2px 5px;border:0;border-radius:5px;background:none;color:var(--muted,#606e84);font-size:10px}
#health-chat .hc-reveal{color:var(--primary-hover,#45639f)}
#health-chat .hc-copy:hover,#health-chat .hc-reveal:hover{background:var(--hover,#f0f4fa);color:var(--primary-hover,#45639f)}
#health-chat .hc-cursor{display:inline-block;width:2px;height:1em;margin-left:2px;background:var(--primary,#5574b5);vertical-align:-.12em;animation:health-chat-caret 1s steps(1) infinite}
@keyframes health-chat-caret{0%,100%{opacity:1}50%{opacity:0}}
#health-chat .hc-message-sources{width:100%;color:var(--muted,#606e84);font-size:10px}
#health-chat .hc-message-sources summary{cursor:pointer}
#health-chat .hc-markdown{white-space:normal}
#health-chat .hc-markdown>:first-child{margin-top:0}
#health-chat .hc-markdown>:last-child{margin-bottom:0}
#health-chat .hc-markdown p{margin:0 0 10px}
#health-chat .hc-markdown h1,#health-chat .hc-markdown h2,#health-chat .hc-markdown h3,#health-chat .hc-markdown h4,#health-chat .hc-markdown h5,#health-chat .hc-markdown h6{margin:16px 0 7px;font-size:14px;font-weight:650;line-height:1.7}
#health-chat .hc-markdown h1{font-size:16px}
#health-chat .hc-markdown h2{font-size:15px}
#health-chat .hc-markdown ul,#health-chat .hc-markdown ol{margin:7px 0 12px;padding-left:21px}
#health-chat .hc-markdown li+li{margin-top:4px}
#health-chat .hc-markdown li>p{margin:0 0 6px}
#health-chat .hc-markdown blockquote{margin:10px 0;padding:6px 10px;border-left:3px solid #bccde9;background:var(--subtle,#f8fafd);color:var(--muted,#606e84)}
#health-chat .hc-markdown code{padding:2px 4px;border-radius:4px;background:#edf1f7;font:11px/1.8 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
#health-chat .hc-markdown pre{max-width:100%;overflow:auto;padding:10px;border-radius:7px;background:#edf1f7;line-height:1.7}
#health-chat .hc-markdown pre code{padding:0;background:transparent;white-space:pre}
#health-chat .hc-markdown table{display:block;max-width:100%;width:max-content;overflow:auto;border-collapse:collapse;margin:10px 0;font-size:11px;line-height:1.7}
#health-chat .hc-markdown th,#health-chat .hc-markdown td{padding:6px 8px;border:1px solid var(--line,#dfe5ee);min-width:64px;text-align:left;vertical-align:top}
#health-chat .hc-markdown th{background:var(--subtle,#f8fafd);font-weight:600}
#health-chat .hc-markdown a{color:var(--primary-hover,#45639f);text-decoration:underline;text-underline-offset:2px}
#health-chat .hc-markdown hr{border:0;border-top:1px solid var(--line,#dfe5ee);margin:14px 0}
#health-chat .hc-pending{display:flex;align-items:center;gap:8px;color:var(--muted,#606e84);font-size:12px}
#health-chat .hc-pending-dots{display:flex;gap:3px}
#health-chat .hc-pending-dots i{width:4px;height:4px;border-radius:50%;background:#8a9bbb;animation:health-chat-pulse 1.2s ease-in-out infinite}
#health-chat .hc-pending-dots i:nth-child(2){animation-delay:.15s}
#health-chat .hc-pending-dots i:nth-child(3){animation-delay:.3s}
@keyframes health-chat-pulse{0%,70%,100%{opacity:.35}35%{opacity:1}}
#health-chat .hc-compose{flex:none;padding:11px 14px 12px;border-top:1px solid var(--line,#dfe5ee);background:var(--paper,#fff)}
#health-chat .hc-scope-options{padding:8px 14px;border-bottom:1px solid var(--line,#dfe5ee);font-size:11px;color:var(--muted,#606e84)}#health-chat .hc-scope-options label{display:inline-flex;gap:4px;margin:5px 10px 3px 0}#health-chat .hc-range{flex-wrap:wrap}#health-chat .hc-usage{margin:5px 0;font-size:10px;color:var(--muted,#606e84)}
#health-chat .hc-sharing-note{margin:0 0 9px;font-size:10px;line-height:1.75;color:var(--muted,#606e84)}
#health-chat .hc-input-wrap{display:flex;align-items:flex-end;gap:8px;padding:8px 8px 8px 11px;border:1px solid #c9d4e6;border-radius:11px;background:var(--paper,#fff)}
#health-chat .hc-input-wrap:focus-within{border-color:var(--primary,#5574b5);box-shadow:0 0 0 2px rgb(85 116 181 / 9%)}
#health-chat .hc-question{display:block;flex:1;min-width:0;min-height:40px;max-height:126px;resize:none;padding:3px 0;border:0;outline:0;background:transparent;font-size:13px;line-height:1.7;box-shadow:none}
#health-chat .hc-question:focus-visible{outline:0}
#health-chat .hc-question::placeholder{color:#7c899f}
#health-chat .hc-send{display:grid;place-items:center;flex:none;width:34px;height:34px;padding:8px;border:0;border-radius:9px;background:var(--primary,#5574b5);color:#fff}
#health-chat .hc-send:hover:not(:disabled){background:var(--primary-hover,#45639f)}
#health-chat .hc-send svg{width:17px;height:17px}
#health-chat .hc-compose-foot{display:flex;justify-content:space-between;gap:10px;margin-top:7px;color:var(--muted,#606e84);font-size:10px;line-height:1.65}
#health-chat .hc-form-error{margin:0 0 8px;padding:8px 10px;border:1px solid #ecd4ce;border-radius:7px;background:#fff8f6;color:var(--red,#a33131);font-size:11px;line-height:1.8;overflow-wrap:anywhere}
#health-chat .hc-settings{color:var(--muted,#606e84);text-decoration:none;white-space:nowrap}
#health-chat .hc-settings:hover{color:var(--primary-hover,#45639f);text-decoration:underline}
#health-chat .hc-footnote{margin:7px 0 0;color:#7b879a;font-size:9px;line-height:1.6;text-align:center}
@media(max-width:600px){#health-chat .hc-launcher{right:16px;bottom:max(16px,env(safe-area-inset-bottom));min-height:46px;padding:10px 15px;font-size:13px}#health-chat .hc-panel{right:10px;bottom:max(10px,env(safe-area-inset-bottom));width:calc(100vw - 20px);height:calc(100dvh - 20px - env(safe-area-inset-bottom));max-height:calc(100dvh - 20px - env(safe-area-inset-bottom));border-radius:15px}#health-chat .hc-head{padding:13px}#health-chat .hc-scroll{padding:13px}#health-chat .hc-question{font-size:16px;line-height:1.55}#health-chat .hc-compose{padding-bottom:max(12px,env(safe-area-inset-bottom))}}
@media(max-width:980px){#health-chat .hc-launcher{bottom:calc(var(--app-tools-height,0px) + 16px)}}
@media(prefers-reduced-motion:reduce){#health-chat .hc-pending-dots i{animation:none;opacity:.7}#health-chat .hc-cursor{animation:none}}
</style><div id="health-chat" data-health-chat-root>
<button class="hc-launcher" id="health-chat-launcher" type="button" aria-haspopup="dialog" aria-controls="health-chat-panel" aria-expanded="false"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8 12h2l1.2-2.5 1.7 5 1.2-2.5H17"/></svg><span id="health-chat-launcher-label">健康助手</span></button>
<section class="hc-panel" id="health-chat-panel" role="dialog" aria-modal="false" aria-labelledby="health-chat-title" tabindex="-1" hidden>
<header class="hc-head"><span class="hc-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12.5 12 21l-8.5-8.5a5.5 5.5 0 0 1 7.8-7.8l.7.7.7-.7a5.5 5.5 0 0 1 7.8 7.8Z"/><path d="M5 12h4l1.5-3 3 6 1.5-3h4"/></svg></span><div class="hc-title"><h2 id="health-chat-title">健康助手</h2><p id="health-chat-provider">结合你的真实记录，聊聊健康</p></div><div class="hc-head-actions"><button class="hc-icon-button" id="health-chat-new" type="button" aria-label="开始新对话" title="新对话"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></button><button class="hc-icon-button" id="health-chat-minimize" type="button" aria-label="最小化健康助手" title="最小化"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 15h14"/></svg></button><button class="hc-icon-button" id="health-chat-close" type="button" aria-label="关闭健康助手" title="关闭"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div></header>
<div class="hc-scope"><span class="hc-scope-label" id="health-chat-scope-label">本次参考的健康记录</span><div class="hc-range" role="group" aria-label="健康摘要时间范围"><button type="button" data-health-chat-days="7" aria-pressed="true">近 7 天</button><button type="button" data-health-chat-days="30" aria-pressed="false">近 30 天</button><button type="button" data-health-chat-days="90" aria-pressed="false">90 天</button><button type="button" data-health-chat-days="180" aria-pressed="false">180 天</button><button type="button" data-health-chat-days="360" aria-pressed="false">360 天</button></div></div>
<details class="hc-scope-options"><summary>选择本次分享的资料</summary><div role="group" aria-label="分享的健康指标"><label><input type="checkbox" data-health-chat-metric="weight" checked>体重</label><label><input type="checkbox" data-health-chat-metric="lean_body_mass" checked>去脂体重</label><label><input type="checkbox" data-health-chat-metric="steps" checked>步数</label><label><input type="checkbox" data-health-chat-metric="active_energy" checked>活动能量</label><label><input type="checkbox" data-health-chat-metric="sleep" checked>睡眠</label></div><label><input type="checkbox" id="health-chat-include-nutrition" checked>饮食热量、三项营养素与记录状态</label><label><input type="checkbox" id="health-chat-include-goals">参考我设置的目标与启用中的体重计划</label><p>更改范围会开始新对话；仅在点击发送时将预览资料交给 MiniMax。90/180 天按 7 日分组，360 天按 14 日分组，详情以摘要中的实际日期为准。</p></details><div class="hc-scroll" id="health-chat-scroll"><div class="hc-status" id="health-chat-status" role="status" aria-live="polite" hidden><span id="health-chat-status-text"></span><div class="hc-status-actions"><button type="button" class="hc-text-button" id="health-chat-retry" hidden>重新读取</button><a id="health-chat-login" hidden>重新登录</a></div></div><div class="hc-config" id="health-chat-config" hidden><p id="health-chat-config-message"></p><a href="/settings/ai">前往 AI 设置</a></div>
${renderAssistantRangeControl()}
<details class="hc-context" id="health-chat-context" hidden><summary id="health-chat-context-summary">查看健康摘要与来源</summary><p id="health-chat-context-range"></p><dl class="hc-coverage" id="health-chat-coverage"></dl><ul class="hc-source-list" id="health-chat-sources"></ul><p id="health-chat-limitations"></p><p>只分享勾选的指标、日期、饮食热量汇总与用户标记的记录状态；选择参考目标时另含用户自定目标与启用计划；不发送身份、财务、饮食名称或备注。对话内容也会随追问发送给 MiniMax。</p></details>
<div class="hc-welcome" id="health-chat-welcome"><h3>今天，想从哪里开始？</h3><p>一起看看睡眠、活动、体重和饮食的变化。<span class="hc-preset">先给出简要结论，再用记录说明，最后给你可执行的小建议。</span></p><div class="hc-suggestions"><button type="button" data-health-chat-question="请总结最近的健康趋势，并告诉我最值得关注的一件事。">总结最近的健康趋势 <span aria-hidden="true">↗</span></button><button type="button" data-health-chat-question="最近的睡眠有什么变化？请结合实际记录说明。">看看最近的睡眠变化 <span aria-hidden="true">↗</span></button><button type="button" data-health-chat-question="请根据我的健康和饮食记录，给出三个可执行的小建议。">给我三个可执行的小建议 <span aria-hidden="true">↗</span></button></div></div>
<div class="hc-messages" id="health-chat-messages" role="log" aria-label="健康助手对话" aria-live="polite" aria-relevant="additions text"></div></div>
<form class="hc-compose" id="health-chat-form" novalidate><p class="hc-sharing-note">发送后，本次问题、对话历史和所选健康摘要将由 MiniMax 处理。</p><p class="hc-usage" id="health-chat-usage" aria-live="polite">应用调用余量待读取（与 Token Plan 余额不同）</p><p class="hc-form-error" id="health-chat-form-error" role="alert" hidden></p><div class="hc-input-wrap"><textarea class="hc-question" id="health-chat-question" rows="2" maxlength="2000" aria-label="发送给健康助手的问题" aria-describedby="health-chat-input-hint" placeholder="问问你的健康记录…"></textarea><button class="hc-send" id="health-chat-send" type="submit" aria-label="发送消息" title="发送消息" disabled><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13"/></svg></button></div><div class="hc-compose-foot"><span id="health-chat-input-hint">Enter 发送 · Shift+Enter 换行</span><span id="health-chat-count">0 / 1000</span><a class="hc-settings" href="/settings/ai">AI 设置</a></div><p class="hc-footnote">对话仅保留在本页，刷新后清空。健康建议不能替代专业诊疗。</p></form>
</section></div>${renderHealthAssistantWidgetScript()}`;
}
