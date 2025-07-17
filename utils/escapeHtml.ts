/**
 * escapeHtml – replace the five characters that break Telegram’s HTML parse
 */
export const escapeHtml = (s = ''): string =>
  s
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
