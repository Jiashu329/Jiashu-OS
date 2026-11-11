import MarkdownIt from 'markdown-it';

// Model output is untrusted: HTML and remote images are never enabled.
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false, maxNesting: 20 });
markdown.disable('image');
const validateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = (url: string) => validateLink(url)
  && (/^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url) || url.startsWith('#'));
const renderLink = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  token.attrSet('rel', 'noopener noreferrer');
  token.attrSet('referrerpolicy', 'no-referrer');
  if (/^https?:\/\//i.test(String(token.attrGet('href') ?? ''))) token.attrSet('target', '_blank');
  return renderLink ? renderLink(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
};

/** Render only bounded, final assistant answers, never provider metadata. */
export function renderAssistantMarkdown(answer: string): string {
  if (typeof answer !== 'string' || answer.length > 10000) throw new RangeError('健康助手回答超出显示上限。');
  const html = markdown.render(answer);
  return html.length <= 128 * 1024 ? html : '<p>' + markdown.utils.escapeHtml(answer) + '</p>';
}
