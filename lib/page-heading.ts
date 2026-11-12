interface PageHeadingCopy {
  readonly section: string;
  readonly title: string;
  readonly description: string;
}

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeText = (value: string) => value.replace(/[&<>"']/g, (character) => entities[character]);

/** Presentation-only heading copy; page-specific actions stay with their page. */
export function renderPageHeadingCopy({ section, title, description }: PageHeadingCopy): string {
  return `<div class="page-heading-copy"><span class="page-eyebrow">${escapeText(section)}</span><h1>${escapeText(title)}</h1><p class="page-description">${escapeText(description)}</p></div>`;
}
