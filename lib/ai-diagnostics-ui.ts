/** Only bounded numeric codes and hexadecimal trace IDs can reach the page. */
export const AI_DIAGNOSTICS_HELPERS = String.raw`
function diagnosticText(raw){if(!raw||typeof raw!=='object'||Array.isArray(raw))return '';const parts=[];if(Number.isSafeInteger(raw.upstreamCode)&&raw.upstreamCode>0&&raw.upstreamCode<=9999999999)parts.push('MiniMax 错误码：'+raw.upstreamCode);if(Number.isSafeInteger(raw.upstreamStatus)&&raw.upstreamStatus>=100&&raw.upstreamStatus<=599)parts.push('上游 HTTP：'+raw.upstreamStatus);if(typeof raw.traceId==='string'&&/^[a-f0-9]{16,64}$/i.test(raw.traceId))parts.push('追踪 ID：'+raw.traceId);return parts.length?'（'+parts.join('；')+'）':'';}
`;
