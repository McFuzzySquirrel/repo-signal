/**
 * Escaping and document shell shared by every view. One helper per context
 * (text, attribute, URL) and one document shell: no view builds its own
 * document, and no dynamic value reaches a page without the helper for its
 * context.
 */

/**
 * Escape a dynamic value for HTML text context. Safe for element content,
 * never for an attribute or a URL.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Escape a dynamic value for HTML attribute context (double-quoted). This is
 * stricter than text escaping: quotes become entities so the value cannot
 * break out of the attribute.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeAttribute(value) {
  return escapeText(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Escape a dynamic value for URL context: percent-encode it so it can be a
 * path segment or query value inside an href without carrying markup or
 * spaces through. Attribute-escape the result when placing it in an href.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeUrl(value) {
  return encodeURIComponent(String(value ?? '')).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Stylesheet served through the view registry; the server never serves a file. */
export const STYLESHEET_HREF = '/assets/theme.css';

/**
 * The one document shell for every page, including the 400 and 404 pages, so
 * a mistyped URL still looks like the product. It carries the language
 * declaration, the page title, the stylesheet link, a skip link as the first
 * focusable element, and the single main landmark wrapping the view body.
 *
 * @param {object} options
 * @param {string} options.title Unique page title naming the page.
 * @param {string} options.body View-produced HTML with no dynamic value left unescaped.
 * @returns {string}
 */
export function documentShell({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeText(title)}</title>
<link rel="stylesheet" href="${STYLESHEET_HREF}">
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<main id="main">
${body}
</main>
<footer>
<p>Served from 127.0.0.1 only. No page loads a remote asset or runs a script.</p>
</footer>
</body>
</html>
`;
}
