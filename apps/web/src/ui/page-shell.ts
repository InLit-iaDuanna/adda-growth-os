/** Shared HTML shell for server-rendered surfaces. Keeping this here makes the
 * document contract explicit while leaving browser-side behavior inline for
 * the offline/demo deployment. */
export function renderDocument(options: {
  surface?: 'admin' | 'staff' | 'review' | 'consumer';
  lang: string;
  title: string;
  css: string;
  body: string;
  script: string;
}): string {
  const title = escapeHtml(options.title);
  const lang = escapeHtml(options.lang);
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${options.css}</style></head><body data-surface="${escapeHtml(options.surface || 'admin')}"><a class="skip-link" href="#main-content">Skip to content</a>${options.body}<script>${options.script}</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || character);
}
