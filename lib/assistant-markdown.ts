import MarkdownIt from 'markdown-it';
import type { HealthAssistantSource } from './health-assistant-context.ts';

// Model output is untrusted: HTML and remote images are never enabled.
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false, maxNesting: 20 });
markdown.disable('image');
const validateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = (url: string) => validateLink(url)
  && (/^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url) || url.startsWith('#'));
const renderLink = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const label = tokens[index+1]?.type === 'text' ? tokens[index+1].content : '';
  const citation = label.match(/^\[?([HN]\d+(?:-\d{8})?)\]?$/)?.[1];
  const source = citation ? (env?.citations as Map<string,HealthAssistantSource> | undefined)?.get(citation) : undefined;
  const href = source && citationHref(source);
  if (href) { token.attrSet('href',href);token.attrSet('class','hc-citation');token.attrSet('target','_blank'); }
  else if (citation) {
    token.tag='span';token.attrs=[];
    for(let i=index+1;i<tokens.length;i++){if(tokens[i].type==='link_close'){tokens[i].tag='span';break;}}
    return renderer.renderToken(tokens,index,options);
  }
  token.attrSet('rel', 'noopener noreferrer');
  token.attrSet('referrerpolicy', 'no-referrer');
  if (/^https?:\/\//i.test(String(token.attrGet('href') ?? ''))) token.attrSet('target', '_blank');
  return renderLink ? renderLink(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
};

const sourcePaths = new Set(['/health/records', '/health/nutrition', '/health/weight-plan', '/health']);
function citationHref(source: HealthAssistantSource): string | null {
  if (!source.url.startsWith('/') || source.url.startsWith('//')) return null;
  try { const url = new URL(source.url, 'https://source.invalid'); return url.origin === 'https://source.invalid' && sourcePaths.has(url.pathname) ? url.pathname+url.search+url.hash : null; }
  catch { return null; }
}
markdown.renderer.rules.text = (tokens, index, _options, env) => {
  const escape = markdown.utils.escapeHtml, content = tokens[index].content;
  const citations = env?.citations as Map<string, HealthAssistantSource> | undefined;
  let nested = 0;
  for (let i=0;i<index;i++) { if (tokens[i].type === 'link_open') nested++; else if (tokens[i].type === 'link_close') nested--; }
  if (!citations || nested > 0) return escape(content);
  let html = '', offset = 0;
  for (const match of content.matchAll(/\[((?:H[1-5]|N1)(?:-\d{8})?)\]/g)) {
    html += escape(content.slice(offset, match.index));
    const source = citations.get(match[1]), href = source && citationHref(source);
    html += href ? '<a class="hc-citation" href="'+escape(href)+'" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" title="'+escape(source!.label+' · '+source!.from+' — '+source!.to)+'">'+escape(match[0])+'</a>' : escape(match[0]);
    offset = match.index! + match[0].length;
  }
  return html + escape(content.slice(offset));
};

/** Render only bounded, final assistant answers, never provider metadata. */
export function renderAssistantMarkdown(answer: string, sources: readonly HealthAssistantSource[] = []): string {
  if (typeof answer !== 'string' || answer.length > 10000) throw new RangeError('健康助手回答超出显示上限。');
  const citations = new Map(sources.filter((source) => /^(?:H[1-5]|N1)(?:-\d{8})?$/.test(source.id)).map((source) => [source.id,source]));
  const html = markdown.render(answer, { citations });
  return html.length <= 128 * 1024 ? html : '<p>' + markdown.utils.escapeHtml(answer) + '</p>';
}
