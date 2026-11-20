export const BUBBLE_PATH = '/__hivebubble/bubble.js';
export const WS_PATH = '/__hivebubble/ws';
export const BUBBLE_TAG = `<script src="${BUBBLE_PATH}" data-hivebubble defer></script>`;

/**
 * Insert the bubble script into an HTML document: before the last `</body>`,
 * else before `</html>`, else at the end. Idempotent.
 */
export function injectBubble(html: string, tag: string = BUBBLE_TAG): string {
  if (html.includes('data-hivebubble')) return html;
  const lower = html.toLowerCase();
  const body = lower.lastIndexOf('</body>');
  if (body !== -1) return html.slice(0, body) + tag + html.slice(body);
  const end = lower.lastIndexOf('</html>');
  if (end !== -1) return html.slice(0, end) + tag + html.slice(end);
  return html + tag;
}

/** Response headers that would stop the injected script or break the rewritten body. */
export const STRIPPED_HTML_HEADERS = [
  'content-length',
  'content-encoding',
  'content-security-policy',
  'content-security-policy-report-only',
  'transfer-encoding',
  'etag',
];
