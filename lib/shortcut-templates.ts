export const SHORTCUT_TEMPLATES = [
  { id: 'steps', name: '步数', metrics: ['steps'], url: 'https://www.icloud.com/shortcuts/15f4a55757e24b73bc3fc841db91a50d', guide: '/connect-steps' },
  { id: 'active_energy', name: '活动热量', metrics: ['active_energy'], url: 'https://www.icloud.com/shortcuts/bdade70b826c4f0fb05f3a52913844c2', guide: '/connect-steps?metric=active_energy' },
  { id: 'sleep', name: '睡眠', metrics: ['sleep'], url: 'https://www.icloud.com/shortcuts/4e28e8e6257e4a2fa39ee94ff631c03a', guide: '/connect-sleep' },
  { id: 'weight', name: '体重和去脂体重', metrics: ['weight', 'lean_body_mass'], url: 'https://www.icloud.com/shortcuts/bc26b615584d4cb48c26f38ea613c808', guide: '/connect-weight' },
] as const;

export type ShortcutTemplateId = typeof SHORTCUT_TEMPLATES[number]['id'];
export function shortcutTemplate(input: unknown) { return SHORTCUT_TEMPLATES.find((item) => item.id === input) ?? SHORTCUT_TEMPLATES[0]; }

export function renderShortcutInstallCard(id: ShortcutTemplateId) {
  const item = shortcutTemplate(id);
  return `<section class="card shortcut-template-card"><h2>安装${item.name}模板</h2><p>可以先安装你提供的 iCloud 快捷指令，再按下方指南核对网站地址、连接与实际来源。模板内容尚未在当前环境检查，iPhone 安装和运行待验收。</p><div class="actions"><a class="btn primary" href="${item.url}" target="_blank" rel="noopener noreferrer">在 iPhone 安装模板 ↗</a><a class="btn" href="/sync/templates?template=${item.id}">运行后核对同步结果 →</a></div></section>`;
}

export function withShortcutInstallCard(html: string, id: ShortcutTemplateId): string {
  const main = html.indexOf('<main');
  const header = main < 0 ? -1 : html.indexOf('</header>', main);
  if (header < 0) throw new Error('Shortcut guide heading is missing');
  const end = header + '</header>'.length;
  return html.slice(0, end) + renderShortcutInstallCard(id) + html.slice(end);
}
