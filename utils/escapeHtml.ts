// backend/utils/escapeHtml.ts

/**
 * Escape text so it’s safe to embed inside HTML tags
 * (e.g. inside <b>…</b> in Telegram messages).
 */
export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, char => {
    switch (char) {
      case '&':  return '&amp;'
      case '<':  return '&lt;'
      case '>':  return '&gt;'
      case '"':  return '&quot;'
      case "'":  return '&#39;'
      default:   return char
    }
  })
}
