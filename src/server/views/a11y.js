import { readFileSync } from 'node:fs';

import { renderLineChart } from '../../views/components/line-chart.js';
import { escapeAttribute, escapeText } from '../html.js';

/**
 * The reusable half of the accessibility contract, in one module.
 *
 * The pages this product serves are server-rendered strings, so the accessibility
 * contract is a question about markup rather than about runtime behaviour: is
 * there one `main`, is the skip link the first stop a keyboard makes, does any
 * heading level jump, does every figure carry the same numbers as text, does
 * every control have a name in words. Those questions have the same answer on
 * every page, so the pieces that produce the answer live here once and the tests
 * in `tests/views/a11y.test.js` walk the served markup to check them.
 *
 * The module is two halves and neither half substitutes for the other:
 *
 * - **Render helpers** ({@link skipLink}, {@link labelledSection},
 *   {@link namedLink}, {@link chartWithTable}) are what the view modules call, so
 *   a page cannot grow a second, differently-shaped answer to one of these
 *   questions. Each escapes every dynamic value through the shared helpers in
 *   `../html.js`; none reads a clock, opens a file or reaches a host.
 * - **Markup walkers** ({@link auditDocument}, {@link headingLevelSkips},
 *   {@link auditChartPairing}) read a finished document the way a screen reader
 *   and a keyboard user meet it: in document order, by element, over the served
 *   string. They are why the assertions in those tests are about a page rather
 *   than about a constant: a page that renders the wrong landmark fails here even
 *   when every constant in the view modules is correct.
 *
 * One thing is deliberately absent: no colour. A colour literal in a view escapes
 * both the single-source rule and the contrast test, so the tokens live in
 * `src/ui/theme.css` (read through {@link readThemeStylesheet}) and every rule in
 * this module emits `class` and `data-` attributes the stylesheet targets by name.
 * A state is a word in the markup; the stylesheet may make that word bold and
 * nothing more.
 *
 * The document shell in `../html.js` owns the document itself - the language
 * declaration, the single `main` landmark and the skip link - and is never forked
 * here. {@link skipLink} renders exactly the anchor the shell renders, so a page
 * cannot grow a second one and a test can compare the two rather than trust
 * either.
 */

/** The id of the one `main` landmark, which is also what the skip link targets. */
export const SKIP_LINK_TARGET = 'main';

/** The words the skip link is named by. The name has to say where it goes. */
export const SKIP_LINK_TEXT = 'Skip to main content';

/** The class the shell puts on the skip link, which the stylesheet targets. */
export const SKIP_LINK_CLASS = 'skip-link';

/**
 * The one skip link: the first focusable element of every page, pointing at the
 * one `main` landmark. It exists so a keyboard user can step past the repeated
 * navigation instead of reading it again on every page.
 *
 * This renders the same anchor `documentShell` renders, byte for byte. The shell
 * remains the document's owner; this helper is the shape of the skip link, and the
 * tests compare the two rather than trusting either.
 *
 * @returns {string}
 */
export function skipLink() {
  return `<a class="${SKIP_LINK_CLASS}" href="#${SKIP_LINK_TARGET}">${escapeText(SKIP_LINK_TEXT)}</a>`;
}

/**
 * One labelled section: a landmark with its own heading, and the heading carries
 * a generated identifier the section is labelled by.
 *
 * Every page section is built here for two reasons. A section with a heading can
 * be reached by heading navigation, which is how a screen-reader user steps over
 * a page rather than reading all of it; and a section whose `aria-labelledby`
 * points at a heading that exists is a landmark that announces itself, where a
 * `<section>` with no accessible name is announced as nothing at all. The
 * identifier is derived from the section's own key, so it is stable across renders
 * - the render functions are pure and identical input produces identical bytes.
 *
 * @param {object} options
 * @param {string} options.key The section's own key, in `kebab-case`. It becomes
 *   both the `data-section` value and the heading's identifier suffix, so a page
 *   and its test can address the same section by the same word.
 * @param {string} options.heading The heading in a reader's words. It is escaped as
 *   text, and an empty one is refused rather than rendered as an unlabelled
 *   landmark.
 * @param {string} options.body The section's own markup, already escaped by the caller.
 * @param {string} [options.className] Class list for the section element.
 * @param {2|3|4|5|6} [options.level] Heading level, `2` by default. A level is a
 *   structural claim, and a caller that skips one is claiming a section it did not
 *   write.
 * @param {string} [options.anchor] Identifier for the section element itself, so a
 *   control on the page can link to this section by name.
 * @returns {string}
 */
export function labelledSection({ key, heading, body, className, level = 2, anchor }) {
  if (typeof key !== 'string' || !/^[a-z][a-z0-9-]*$/.test(key)) {
    throw new TypeError('A labelled section needs a key in kebab-case such as "collection-state", '
      + `not ${JSON.stringify(key)}`);
  }
  const text = String(heading ?? '').trim();
  if (text === '') throw new TypeError(`The ${key} section needs a heading in words, not an unlabelled landmark`);
  if (!Number.isInteger(level) || level < 2 || level > 6) {
    throw new TypeError(`The ${key} section carries heading level ${String(level)}; a section heading is `
      + 'between h2 and h6, and h1 belongs to the page');
  }
  const headingId = `${key}-heading`;
  const identifier = anchor === undefined ? '' : ` id="${escapeAttribute(anchor)}"`;
  return `<section class="${escapeAttribute(className ?? `section-${key}`)}" data-section="${escapeAttribute(key)}"`
    + `${identifier} aria-labelledby="${escapeAttribute(headingId)}">`
    + `<h${level} id="${escapeAttribute(headingId)}">${escapeText(text)}</h${level}>`
    + `${body}</section>`;
}

/**
 * One control with a name in words.
 *
 * Every interactive element on a page is a link or a button, and every one of
 * them is named by the text inside it. That is the whole rule: a name is not a
 * placeholder, not a title attribute, not an icon and not an `aria-label` bolted
 * onto an empty anchor, and this helper emits none of those. A name with no letter
 * or digit in it - a chevron, an arrow, a bare multiplication sign - is refused by
 * name, because that is an icon wearing an anchor's clothes.
 *
 * The visible text is the name, which also keeps the label in the name: what a
 * reader sees and what a screen reader announces are the same string.
 *
 * @param {object} options
 * @param {string} options.href The reference, already percent-encoded by the caller
 *   and attribute-escaped here.
 * @param {string} options.name The accessible name, which is also the visible text.
 *   It must contain a letter or a digit.
 * @param {string} [options.description] A sentence beside the control, outside the
 *   anchor, naming what following it will do.
 * @param {string} [options.className] Class list for the anchor.
 * @returns {string}
 */
export function namedLink({ href, name, description, className }) {
  if (typeof href !== 'string' || href === '') {
    throw new TypeError('A link needs a reference to follow');
  }
  const label = String(name ?? '').trim();
  if (!/[\p{L}\p{N}]/u.test(label)) {
    throw new TypeError('A link needs an accessible name in words; '
      + `${JSON.stringify(name)} is a placeholder or an icon, and neither names a control`);
  }
  const classAttribute = className === undefined ? '' : ` class="${escapeAttribute(className)}"`;
  const note = description === undefined || String(description).trim() === ''
    ? ''
    : `<span class="link-note">${escapeText(String(description).trim())}</span>`;
  return `<a href="${escapeAttribute(href)}"${classAttribute}>${escapeText(label)}</a>${note}`;
}

/** @typedef {import('../../views/components/line-chart.js').LineChartRequest} LineChartRequest */

/**
 * One chart with its data table, or nothing at all.
 *
 * The chart component already draws the line and emits the paired table; what it
 * cannot do is stop somebody from mounting the chart without the table. This
 * wrapper is where that is decided: it renders the chart, walks the markup that
 * came back and refuses to return a figure whose numbers exist only as a picture.
 * A figure with no table beside it, a table with no caption, or a chart that
 * describes itself with an identifier that resolves to nothing is a defect, so it
 * is thrown at the render rather than shipped to a page.
 *
 * @param {LineChartRequest} request What the chart component takes.
 * @returns {string} The figure and its data table.
 */
export function chartWithTable(request) {
  const markup = renderLineChart(request);
  const pairing = auditChartPairing(markup);
  if (!pairing.paired) {
    throw new TypeError(`A chart must carry its data table: ${pairing.reasons.join('; ')}. `
      + 'No information may exist only inside a picture.');
  }
  return markup;
}

/**
 * Where the colour tokens live, relative to this module. The file is read, never
 * served out of a directory: the dashboard has no static file server, and a route
 * that answered whatever a URL named would be a file server with a different
 * spelling.
 */
export const THEME_TOKEN_FILE = new URL('../../ui/theme.css', import.meta.url);

/** Where the stylesheet is served from, which is what the document shell links to. */
export const THEME_STYLESHEET_PATH = '/assets/theme.css';

/** The content type the stylesheet is served with. */
export const THEME_CONTENT_TYPE = 'text/css; charset=utf-8';

/**
 * The stylesheet, as the bytes the route serves.
 *
 * Reading it here is the only I/O this module does, and it happens on the
 * stylesheet route rather than inside any render function: a render function that
 * opened a file would not be a function of its arguments, and two renders of one
 * archive would stop being byte-identical.
 *
 * @returns {string}
 */
export function readThemeStylesheet() {
  return readFileSync(THEME_TOKEN_FILE, 'utf8');
}

/**
 * @typedef {object} FocusableElement
 * @property {string} tag The element name, lower case.
 * @property {Record<string, string>} attributes Its attributes, entities decoded.
 * @property {string} text Its visible text: markup stripped, entities decoded.
 * @property {number} index Position in document order among the focusable elements.
 */

/**
 * @typedef {object} HeadingElement
 * @property {number} level 1 to 6.
 * @property {string} id The heading's identifier, or an empty string.
 * @property {string} text The heading in a reader's words.
 */

/**
 * @typedef {object} TableSummary
 * @property {string} id
 * @property {string} caption The caption's text, or an empty string when absent.
 * @property {string[]} columnHeaders The `th` cells of the head row.
 * @property {{ label: string, cells: string[] }[]} rows One entry per body row: the
 *   row's own heading cell and its data cells.
 * @property {boolean} insideFigure Whether the table sits inside a `figure`.
 */

/**
 * @typedef {object} FigureSummary
 * @property {string} id
 * @property {string} labelledBy The `aria-labelledby` the figure carries.
 * @property {string[]} describedBy The identifiers the figure and its chart point at.
 * @property {boolean} hasSvg Whether the figure holds an `svg`.
 * @property {boolean} hasCaption Whether the figure holds a `figcaption`.
 * @property {string} caption The `figcaption`'s text, which is what states in words
 *   what the picture plots and which days it has none for.
 * @property {Set<string>} ids Every identifier the figure declares.
 * @property {TableSummary[]} tables The tables inside the figure.
 */

/**
 * @typedef {object} DocumentAudit
 * @property {string} lang The declared document language, or an empty string.
 * @property {string[]} titles The document's `title` elements, in order.
 * @property {number} mainLandmarks How many `main` landmarks the document holds.
 * @property {FocusableElement[]} focusable Every focusable element, in document
 *   order, which is the order a keyboard visits them in.
 * @property {HeadingElement[]} headings Every heading, in document order.
 * @property {FigureSummary[]} figures Every figure, in document order.
 * @property {TableSummary[]} tables Every table, in document order.
 * @property {string[]} ids Every identifier the document declares.
 */

/**
 * Walk a finished document the way a reader meets it.
 *
 * Nothing here is a product decision: this is markup read in document order, so
 * what a test asserts from it is a statement about the page the dashboard served
 * rather than about a constant in a view module. A missing landmark, a renamed
 * heading, a figure whose table was dropped and a control that lost its name all
 * show up here.
 *
 * @param {string} markup A complete document, or any fragment of one.
 * @returns {DocumentAudit}
 */
export function auditDocument(markup) {
  const source = typeof markup === 'string' ? markup : '';
  const figures = sliceElements(source, 'figure');
  /** @type {FigureSummary[]} */
  const figureSummaries = [];
  for (const figure of figures) {
    /** @type {TableSummary[]} */
    const tables = [];
    for (const table of sliceElements(figure.markup, 'table')) {
      tables.push({ ...summariseTable(table.markup), insideFigure: true });
    }
    const svg = sliceElements(figure.markup, 'svg')[0];
    const described = [
      ...splitIdentifiers(attribute(figure.attributes, 'aria-describedby') ?? ''),
      ...(svg === undefined ? [] : splitIdentifiers(attribute(svg.attributes, 'aria-describedby') ?? '')),
    ];
    figureSummaries.push({
      id: attribute(figure.attributes, 'id') ?? '',
      labelledBy: attribute(figure.attributes, 'aria-labelledby') ?? '',
      describedBy: described,
      hasSvg: svg !== undefined,
      hasCaption: sliceElements(figure.markup, 'figcaption').length > 0,
      caption: visibleText(sliceElements(figure.markup, 'figcaption')[0]?.markup ?? ''),
      ids: idsOf(figure.markup),
      tables,
    });
  }
  return {
    lang: /<html\b[^>]*\blang="([^"]*)"/i.exec(source)?.[1] ?? '',
    titles: [...source.matchAll(/<title>([\s\S]*?)<\/title>/gi)].map((match) => visibleText(match[1] ?? '')),
    mainLandmarks: (source.match(/<main\b/gi) ?? []).length,
    focusable: focusableElements(source),
    headings: headingElements(source),
    figures: figureSummaries,
    tables: sliceElements(source, 'table').map((table) => {
      const summary = summariseTable(table.markup);
      const insideFigure = figures.some((figure) => figure.start <= table.start && table.start < figure.end);
      return { ...summary, insideFigure };
    }),
    ids: [...idsOf(source)],
  };
}

/**
 * @param {string} markup
 * @returns {HeadingElement[]} Every heading, in document order.
 */
function headingElements(markup) {
  return [...markup.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)].map((match) => ({
    level: Number(match[1]),
    id: attribute(match[2] ?? '', 'id') ?? '',
    text: visibleText(match[3] ?? ''),
  }));
}

/**
 * @param {string} markup
 * @returns {FocusableElement[]} Every focusable element, in document order.
 */
function focusableElements(markup) {
  /** @type {FocusableElement[]} */
  const found = [];
  for (const match of markup.matchAll(/<(a|button|input|select|textarea)\b([^>]*)>/gi)) {
    const tag = (match[1] ?? '').toLowerCase();
    const start = match.index ?? 0;
    const close = markup.indexOf(`</${tag}>`, start);
    const inner = close === -1 ? '' : markup.slice(start + match[0].length, close);
    found.push({
      tag,
      attributes: attributesOf(match[2] ?? ''),
      text: visibleText(inner),
      index: found.length,
    });
  }
  return found;
}

/**
 * @param {string} tableMarkup
 * @returns {TableSummary}
 */
function summariseTable(tableMarkup) {
  const head = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(tableMarkup)?.[1] ?? '';
  const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(tableMarkup)?.[1] ?? tableMarkup;
  const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => {
    const inner = match[1] ?? '';
    const label = /<th\b[^>]*>([\s\S]*?)<\/th>/i.exec(inner)?.[1] ?? '';
    const cells = [...inner.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((cell) => visibleText(cell[1] ?? ''));
    return { label: visibleText(label), cells };
  });
  return {
    id: attribute(/<table\b([^>]*)>/i.exec(tableMarkup)?.[1] ?? '', 'id') ?? '',
    caption: visibleText(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(tableMarkup)?.[1] ?? ''),
    columnHeaders: [...head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
      .map((match) => visibleText(match[1] ?? '')),
    rows,
    insideFigure: false,
  };
}

/**
 * @typedef {object} ElementSlice
 * @property {string} markup The element and everything inside it.
 * @property {string} attributes Its opening tag's attributes.
 * @property {number} start Index of the opening tag in the source.
 * @property {number} end Index just past the closing tag.
 */

/**
 * Every element of one name, with its own markup, matching a nested element of the
 * same name rather than stopping at the first closing tag. `<table>` is matched on
 * its whole name, so a `<thead>` is never mistaken for one.
 *
 * @param {string} markup
 * @param {string} name Lower-case element name.
 * @returns {ElementSlice[]}
 */
export function sliceElements(markup, name) {
  const pattern = new RegExp(`<(/?)${name}\\b([^>]*?)(/?)>`, 'gi');
  /** @type {ElementSlice[]} */
  const found = [];
  let depth = 0;
  let start = -1;
  let attributes = '';
  for (const match of markup.matchAll(pattern)) {
    const at = match.index ?? 0;
    if ((match[1] ?? '') === '/') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        found.push({
          markup: markup.slice(start, at + match[0].length),
          attributes,
          start,
          end: at + match[0].length,
        });
        start = -1;
      }
      continue;
    }
    if ((match[3] ?? '') === '/') continue;
    if (depth === 0) {
      start = at;
      attributes = match[2] ?? '';
    }
    depth += 1;
  }
  return found;
}

/**
 * @param {string} attributes A raw attribute string.
 * @param {string} name Attribute name.
 * @returns {string|undefined} The attribute's value, entities decoded.
 */
export function attribute(attributes, name) {
  const found = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);
  return found === null ? undefined : decodeEntities(found[1] ?? '');
}

/**
 * @param {string} attributes A raw attribute string.
 * @returns {Record<string, string>}
 */
export function attributesOf(attributes) {
  /** @type {Record<string, string>} */
  const found = {};
  for (const match of attributes.matchAll(/([a-z-]+)="([^"]*)"/gi)) {
    found[(match[1] ?? '').toLowerCase()] = decodeEntities(match[2] ?? '');
  }
  return found;
}

/**
 * The identifiers of an `aria-*` reference, whitespace split.
 *
 * @param {string} reference
 * @returns {string[]}
 */
function splitIdentifiers(reference) {
  return reference.split(/\s+/).filter((entry) => entry !== '');
}

/**
 * @param {string} markup
 * @returns {Set<string>} Every identifier the markup declares.
 */
function idsOf(markup) {
  return new Set([...markup.matchAll(/\bid="([^"]*)"/g)].map((match) => match[1] ?? ''));
}

/**
 * The text a reader reads: markup stripped and the entities the escaping helpers
 * produce decoded, so a name can be compared with the words the page was built
 * from rather than with their escaped spelling.
 *
 * @param {string} markup
 * @returns {string}
 */
export function visibleText(markup) {
  return decodeEntities(markup.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} value
 * @returns {string} The value with the entities `escapeText` and `escapeAttribute`
 *   produce decoded.
 */
export function decodeEntities(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&middot;', '·')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&');
}

/**
 * @typedef {object} HeadingSkip
 * @property {number} after The level before the skip.
 * @property {number} level The level that skipped.
 */

/**
 * Every place a heading sequence skips a level.
 *
 * A jump from `h2` to `h4` tells a screen-reader user that a level of the page's
 * structure is missing, whether or not anything is visually missing. The walk is
 * over the levels in document order, so a page ordered `[1, 2, 2, 3]` returns
 * nothing and a page ordered `[1, 3]` returns that one jump.
 *
 * @param {number[]} levels Heading levels in document order.
 * @returns {HeadingSkip[]} The jumps, empty when the sequence skips none.
 */
export function headingLevelSkips(levels) {
  /** @type {HeadingSkip[]} */
  const skips = [];
  for (let index = 1; index < levels.length; index += 1) {
    const previous = /** @type {number} */ (levels[index - 1]);
    const level = /** @type {number} */ (levels[index]);
    if (level > previous + 1) skips.push({ after: previous, level });
  }
  return skips;
}

/**
 * @typedef {object} ChartPairing
 * @property {boolean} paired Whether the figure carries its own values as text.
 * @property {string[]} reasons What is missing, empty when `paired`.
 * @property {FigureSummary[]} figures The figures found.
 */

/**
 * Whether a chart's markup carries its values as text, and what is missing if not.
 *
 * Four things have to hold and they are checked in this order: there is exactly
 * one figure; that figure carries exactly one data table with a caption and at
 * least one row; the figure carries a caption stating what it plots; and every
 * identifier the figure and its chart point at resolves inside the figure - so a
 * chart that describes itself with a caption id nothing holds is not a chart with
 * a text alternative.
 *
 * @param {string} markup One chart's markup.
 * @returns {ChartPairing}
 */
export function auditChartPairing(markup) {
  const audit = auditDocument(markup);
  /** @type {string[]} */
  const reasons = [];
  if (audit.figures.length !== 1) {
    reasons.push(`expected exactly one figure, found ${audit.figures.length}`);
  }
  for (const figure of audit.figures) {
    if (figure.tables.length !== 1) {
      reasons.push(`the figure carries ${figure.tables.length} data tables, so its values are not all in text`);
    }
    for (const table of figure.tables) {
      if (table.caption === '') reasons.push(`the paired table ${table.id} carries no caption`);
      if (table.rows.length === 0) reasons.push(`the paired table ${table.id} carries no rows`);
    }
    if (!figure.hasCaption) reasons.push('the figure carries no caption stating what it plots');
    for (const reference of figure.describedBy) {
      if (!figure.ids.has(reference)) {
        reasons.push(`the chart describes itself with ${reference}, which is not an element of the figure`);
      }
    }
  }
  return { paired: reasons.length === 0, reasons, figures: audit.figures };
}

/**
 * @typedef {object} LegendEntry
 * @property {string} name The entry's text, which is its own name.
 * @property {boolean} dashed Whether its swatch is drawn with a dash.
 */

/**
 * The legend a chart carries, read as a reader reads it: each treatment named in
 * words beside the swatch that draws it. A chart whose provenance can only be told
 * from a dash fails here, because RS-AX-01 forbids meaning by appearance alone.
 *
 * @param {string} markup One chart's markup.
 * @returns {LegendEntry[]}
 */
export function chartLegendEntries(markup) {
  return [...markup.matchAll(/<li class="chart-legend-entry"[^>]*>([\s\S]*?)<\/li>/g)].map((match) => ({
    name: visibleText(match[1] ?? ''),
    dashed: /stroke-dasharray="[^"]+"/.test(match[1] ?? ''),
  }));
}