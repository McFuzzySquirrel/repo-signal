import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The contrast contract, computed rather than believed.
 *
 * WCAG 2.1 AA asks for 4.5:1 between text and its background and 3:1 for everything
 * else a reader has to see - a border, a focus ring, a chart stroke. A number
 * written in a comment goes stale the moment a colour changes, so nothing here is
 * taken on trust: the pairs are declared in the stylesheet itself, both tokens are
 * resolved to the values the same file declares, and the ratio is computed from the
 * WCAG formula in this file and compared with the threshold the requirement names.
 *
 * Four properties are what make the check worth having, and each is asserted:
 *
 * 1. **The arithmetic is right.** The formula is checked against values with
 *    published answers - black on white is 21:1, `#767676` on white is the 4.54:1
 *    grey every contrast discussion cites, and a colour at 2.17:1 fails both
 *    thresholds. A ratio computation that is wrong in the optimistic direction would
 *    otherwise pass everything.
 * 2. **Every pair is computed.** A pair that falls below its role's threshold fails
 *    with the two tokens and the computed ratio in the message.
 * 3. **No colour escapes.** Every colour token the stylesheet declares takes part in
 *    at least one declared pair, every colour literal in the file sits inside the
 *    token block, and no other file in `src`, `tests` or `scripts` declares a colour
 *    at all - so a colour added here forces a decision about what it is read
 *    against, and a colour added anywhere else is a colour the test cannot see.
 * 4. **The stylesheet is plain.** System fonts only, no `@import`, no `@font-face`,
 *    no `url()`, no remote host, and no `transition`, `animation` or `@keyframes`:
 *    the reduced-motion preference is respected trivially because there is no motion,
 *    and no page can reach a host to fetch anything.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const THEME_PATH = path.join(ROOT, 'src', 'ui', 'theme.css');

/** The threshold AA sets for text against its background, from RS-AX-01. */
const TEXT_CONTRAST_MINIMUM = 4.5;
/** The threshold AA sets for everything else that has to be seen. */
const NON_TEXT_CONTRAST_MINIMUM = 3;

/** What a colour literal looks like, in a hex form this file accepts. */
const HEX_PATTERN = /^#[0-9a-f]{6}$/;

/** @typedef {{ red: number, green: number, blue: number }} Rgb */

/**
 * @typedef {object} Declaration
 * @property {string} name The custom property or property being declared.
 * @property {string} value Its value, trimmed.
 * @property {number} start Index of the declaration in the stylesheet.
 * @property {number} end Index just past the declaration.
 */

/**
 * @typedef {object} ContrastPair
 * @property {string} name The pair's own name.
 * @property {'text'|'non-text'} role Which threshold the comparison is for.
 * @property {string} foreground The token name read first.
 * @property {string} background The token name read against it.
 */

const theme = readFileSync(THEME_PATH, 'utf8');

/**
 * The stylesheet with its comments removed. A comment naming a forbidden construct is
 * not a declaration of one, and this stylesheet explains at length why it has none.
 *
 * @param {string} css
 * @returns {string}
 */
function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * The `:root` block, with the offsets of its braces.
 *
 * The block is found by brace matching rather than by a regular expression, so a
 * stylesheet with several blocks - which this one has, below the tokens - still has
 * exactly one token block located.
 *
 * @param {string} css
 * @returns {{ start: number, end: number, text: string }}
 */
function tokenBlock(css) {
  const root = /:root\s*\{/.exec(css);
  assert.ok(root !== null, 'the stylesheet declares its tokens in a :root block');
  const start = /** @type {number} */ (root.index);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1, text: css.slice(open + 1, index) };
    }
  }
  throw new Error('the :root block is never closed');
}

/**
 * Every declaration in a block of CSS, in document order.
 *
 * @param {string} css
 * @returns {Declaration[]}
 */
function parseDeclarations(css) {
  /** @type {Declaration[]} */
  const declarations = [];
  for (const match of css.matchAll(/(--[a-z0-9-]+|[a-z-]+)\s*:\s*([^;{}]+);/g)) {
    declarations.push({
      name: match[1] ?? '',
      value: (match[2] ?? '').trim(),
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return declarations;
}

/**
 * @param {unknown} value
 * @returns {Rgb}
 */
function parseColour(value) {
  const text = String(value).trim().toLowerCase();
  assert.ok(HEX_PATTERN.test(text),
    `a token must name a colour as a six-digit hex value; got ${JSON.stringify(value)}`);
  return {
    red: Number.parseInt(text.slice(1, 3), 16),
    green: Number.parseInt(text.slice(3, 5), 16),
    blue: Number.parseInt(text.slice(5, 7), 16),
  };
}

/**
 * @param {number} channel One 8-bit channel.
 * @returns {number} Its linear-light value, per WCAG 2.1.
 */
function linearise(channel) {
  const proportion = channel / 255;
  return proportion <= 0.03928 ? proportion / 12.92 : ((proportion + 0.055) / 1.055) ** 2.4;
}

/**
 * @param {Rgb} colour
 * @returns {number} The relative luminance, per WCAG 2.1.
 */
export function relativeLuminance(colour) {
  return 0.2126 * linearise(colour.red) + 0.7152 * linearise(colour.green) + 0.0722 * linearise(colour.blue);
}

/**
 * @param {Rgb} foreground
 * @param {Rgb} background
 * @returns {number} The contrast ratio, from 1 to 21.
 */
export function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * @param {ContrastPair['role']} role
 * @returns {number} The threshold that role has to meet.
 */
function thresholdFor(role) {
  return role === 'text' ? TEXT_CONTRAST_MINIMUM : NON_TEXT_CONTRAST_MINIMUM;
}

/**
 * The contrast pairs the stylesheet declares, in declaration order.
 *
 * A pair names its role explicitly, so a pair that forgets to say whether it is text
 * or not is refused here rather than quietly checked against the wrong threshold.
 *
 * @param {Declaration[]} declarations
 * @returns {ContrastPair[]}
 */
function parsePairs(declarations) {
  /** @type {ContrastPair[]} */
  const pairs = [];
  for (const declaration of declarations) {
    if (!declaration.name.startsWith('--rs-pair-')) continue;
    const parsed = /^(text|non-text)\s+var\((--rs-[a-z0-9-]+)\)\s+var\((--rs-[a-z0-9-]+)\)$/
      .exec(declaration.value);
    assert.ok(parsed !== null,
      `the pair ${declaration.name} must read "<text|non-text> var(--foreground) var(--background)"; `
      + `got ${JSON.stringify(declaration.value)}`);
    pairs.push({
      name: declaration.name,
      role: /** @type {'text'|'non-text'} */ (parsed[1]),
      foreground: parsed[2] ?? '',
      background: parsed[3] ?? '',
    });
  }
  return pairs;
}

/**
 * The colour tokens the token block declares, by name.
 *
 * @param {Declaration[]} declarations
 * @returns {Map<string, Rgb>}
 */
function parseColourTokens(declarations) {
  /** @type {Map<string, Rgb>} */
  const tokens = new Map();
  for (const declaration of declarations) {
    if (!HEX_PATTERN.test(declaration.value.toLowerCase())) continue;
    tokens.set(declaration.name, parseColour(declaration.value));
  }
  return tokens;
}

/**
 * @param {string} css
 * @returns {{ tokens: Map<string, Rgb>, pairs: ContrastPair[], declarations: Declaration[], block: { start: number, end: number, text: string } }}
 */
function readTheme(css) {
  const declarations = withoutComments(css);
  const block = tokenBlock(declarations);
  const parsed = parseDeclarations(block.text);
  return {
    declarations: parsed,
    block,
    tokens: parseColourTokens(parsed),
    pairs: parsePairs(parsed),
  };
}

test('the ratio computation agrees with values whose answers are published', () => {
  // Act and assert, against the WCAG formula and its known cases.
  const white = parseColour('#ffffff');
  const black = parseColour('#000000');
  assert.equal(contrastRatio(black, white), 21, 'black on white is the maximum ratio, 21:1');
  assert.equal(contrastRatio(white, white), 1, 'a colour against itself is 1:1');
  assert.equal(contrastRatio(black, white), contrastRatio(white, black), 'the ratio does not depend on order');

  // The grey every contrast discussion cites: 4.54:1 on white, just over the text
  // threshold and just under nothing, which is why it is the reference case.
  const reference = parseColour('#767676');
  assert.ok(Math.abs(contrastRatio(reference, white) - 4.54) < 0.01,
    `#767676 on white is 4.54:1; computed ${contrastRatio(reference, white).toFixed(4)}`);
  assert.ok(Math.abs(contrastRatio(parseColour('#595959'), white) - 7) < 0.01,
    '#595959 on white is 7:1');

  // And the predicate the rest of this file applies is the one those values imply.
  const failing = parseColour('#b0b0b0');
  const nonTextPassing = parseColour('#949494');
  assert.ok(contrastRatio(failing, white) < NON_TEXT_CONTRAST_MINIMUM,
    'a 2.17:1 grey fails even the non-text threshold');
  assert.ok(contrastRatio(nonTextPassing, white) >= NON_TEXT_CONTRAST_MINIMUM
    && contrastRatio(nonTextPassing, white) < TEXT_CONTRAST_MINIMUM,
    'a 3.03:1 grey passes as non-text and fails as text, so the two thresholds differ');
  assert.equal(thresholdFor('text'), TEXT_CONTRAST_MINIMUM);
  assert.equal(thresholdFor('non-text'), NON_TEXT_CONTRAST_MINIMUM);
});

test('every declared contrast pair meets the AA threshold, computed from the two tokens', () => {
  // Arrange: the pairs the stylesheet declares, resolved against the tokens the same
  // file declares.
  const { tokens, pairs } = readTheme(theme);

  // Act and assert: each pair's ratio, computed here, compared with the threshold its
  // own role names.
  assert.ok(pairs.length > 0, 'the stylesheet declares the pairs it wants checked');
  assert.ok(pairs.some((pair) => pair.role === 'text'), 'at least one text pair is declared');
  assert.ok(pairs.some((pair) => pair.role === 'non-text'), 'at least one non-text pair is declared');
  for (const pair of pairs) {
    const foreground = tokens.get(pair.foreground);
    const background = tokens.get(pair.background);
    assert.ok(foreground !== undefined,
      `${pair.name}: ${pair.foreground} is declared as a colour in the token block`);
    assert.ok(background !== undefined,
      `${pair.name}: ${pair.background} is declared as a colour in the token block`);
    const ratio = contrastRatio(/** @type {Rgb} */ (foreground), /** @type {Rgb} */ (background));
    const threshold = thresholdFor(pair.role);
    assert.ok(ratio >= threshold,
      `${pair.name}: ${pair.foreground} on ${pair.background} is ${ratio.toFixed(2)}:1, `
      + `below the ${threshold}:1 a ${pair.role} pair has to meet`);
  }

  // The pair the whole stylesheet rests on is stated as a text pair, and the border
  // and focus ring are non-text, because those are the two roles WCAG distinguishes.
  const byName = new Map(pairs.map((pair) => [pair.name, pair]));
  assert.equal(byName.get('--rs-pair-body-text')?.role, 'text', 'body text is a text pair');
  assert.equal(byName.get('--rs-pair-border')?.role, 'non-text', 'a border is a non-text pair');
  assert.equal(byName.get('--rs-pair-focus-ring')?.role, 'non-text', 'a focus ring is a non-text pair');
});

test('every colour token takes part in a declared pair, so a new colour cannot escape', () => {
  // Arrange: the colour tokens, and the pairs that reference them.
  const { tokens, pairs } = readTheme(theme);
  const referenced = new Set(pairs.flatMap((pair) => [pair.foreground, pair.background]));

  // Act and assert: no colour token sits outside every pair.
  const unpaired = [...tokens.keys()].filter((name) => !referenced.has(name)).sort();
  assert.deepEqual(unpaired, [],
    `every colour token takes part in a pair; these do not: ${JSON.stringify(unpaired)}`);
  assert.ok(tokens.size >= 5, `the stylesheet declares several colours; found ${tokens.size}`);

  // The check is not vacuous: a stylesheet with a colour nobody pairs is reported, and
  // a pair that forgets to name its role is refused rather than checked silently.
  const withAnExtra = theme.replace('  --rs-border: ', '  --rs-unpaired: #123456;\n  --rs-border: ');
  assert.ok([...readTheme(withAnExtra).tokens.keys()].includes('--rs-unpaired'),
    'the probe stylesheet really declares the extra colour');
  const probeUnpaired = [...readTheme(withAnExtra).tokens.keys()]
    .filter((name) => !new Set(readTheme(withAnExtra).pairs.flatMap((pair) => [pair.foreground, pair.background])).has(name));
  assert.deepEqual(probeUnpaired, ['--rs-unpaired'], 'an unpaired colour is reported as unpaired');
  const roleLess = theme.replace('--rs-pair-body-text: text ', '--rs-pair-body-text: ');
  assert.throws(() => readTheme(roleLess), /text\|non-text/,
    'a pair that does not say which threshold it is for is refused');

  // Every colour literal in the file sits inside the token block, so no rule below can
  // name a colour of its own that the contrast test never sees.
  const declarations = withoutComments(theme);
  const block = tokenBlock(declarations);
  for (const literal of declarations.matchAll(/#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/gi)) {
    const at = literal.index ?? 0;
    assert.ok(at >= block.start && at < block.end,
      `the colour literal at offset ${at} sits outside the token block`);
  }
  assert.equal([...tokens.keys()].every((name) => name.startsWith('--rs-')), true,
    'the tokens are this product\'s own, named with one prefix');
});

test('every colour a rule paints on a surface has a declared pair for that surface', () => {
  // Arrange: every colour the rules paint, with the backdrop each one is painted on.
  const declarations = withoutComments(theme);
  const { pairs } = readTheme(theme);
  /** @type {Set<string>} */
  const declared = new Set(pairs.map((pair) => `${pair.foreground}|${pair.background}`));

  // Act and assert: every rule's colour pair is one the stylesheet declared.
  assert.deepEqual(uncheckedUsages(declarations, declared), [],
    'every colour a rule paints on a surface has a declared pair for that surface');

  // The scan is not vacuous: a rule that paints a colour on a surface no pair covers is
  // reported rather than passed over, and a pair that already exists is not reported twice.
  const withAnExtraRule = declarations.replace(
    'figcaption {',
    '.unpaired { background-color: var(--rs-surface-subtle); color: var(--rs-link); }\nfigcaption {',
  );
  assert.deepEqual(uncheckedUsages(withAnExtraRule, declared),
    ['.unpaired: --rs-link on --rs-surface-subtle'],
    'a rule painting a colour on a surface with no declared pair is reported');
});

/**
 * @typedef {object} ColourUsage
 * @property {string} selector The rule that paints it.
 * @property {string} foreground The token a reader has to see.
 * @property {string} backdrop The token it is painted on.
 */

/**
 * Every colour the rules of a stylesheet paint, with the surface each is painted on.
 *
 * The backdrop is the background the rule declares, and the page surface for a rule
 * that declares none - which holds here because the document sets its background once,
 * on the root, and no rule puts a colour on any other surface without saying so.
 *
 * @param {string} css
 * @returns {ColourUsage[]}
 */
function colourUsages(css) {
  /** @type {ColourUsage[]} */
  const usages = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (rule[1] ?? '').trim();
    const declarationsInRule = parseDeclarations(rule[2] ?? '');
    const background = declarationsInRule
      .find((declaration) => declaration.name === 'background' || declaration.name === 'background-color');
    const backdrop = background?.value.match(/var\((--rs-[a-z0-9-]+)\)/)?.[1] ?? '--rs-surface';
    for (const declaration of declarationsInRule) {
      const isText = declaration.name === 'color';
      const isLine = declaration.name === 'outline' || declaration.name.startsWith('border');
      if (!isText && !isLine) continue;
      for (const token of declaration.value.matchAll(/var\((--rs-[a-z0-9-]+)\)/g)) {
        usages.push({ selector, foreground: token[1] ?? '', backdrop });
      }
    }
  }
  return usages;
}

/**
 * The colour pairings a stylesheet paints without a declared contrast pair.
 *
 * @param {string} css
 * @param {ReadonlySet<string>} declared Pair names as `foreground|background`.
 * @returns {string[]}
 */
function uncheckedUsages(css, declared) {
  return colourUsages(css)
    .filter((usage) => !declared.has(`${usage.foreground}|${usage.backdrop}`))
    .map((usage) => `${usage.selector}: ${usage.foreground} on ${usage.backdrop}`);
}

test('no file other than the stylesheet declares a colour literal', () => {
  // Arrange: every source, test and script file the product ships.
  const allowed = new Set([
    THEME_PATH,
    // This file carries reference colours of its own so the arithmetic above can be
    // checked against published answers. A colour in a test cannot reach a page, and a
    // colour in the product would be invisible to the contrast test.
    path.join(ROOT, 'tests', 'contrast.test.js'),
  ]);
  const pattern = /#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/i;

  // Act and assert: no other file declares one.
  /** @type {string[]} */
  const offenders = [];
  for (const file of walkTree(ROOT, ['src', 'tests', 'scripts'])) {
    if (allowed.has(file)) continue;
    if (pattern.test(readFileSync(file, 'utf8'))) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [],
    `only the theme stylesheet may declare a colour literal; got ${JSON.stringify(offenders)}`);
  assert.ok(pattern.test(readFileSync(THEME_PATH, 'utf8')), 'the stylesheet does declare colours');

  // The search is not vacuous: the pattern really does recognise a colour literal, and
  // really does ignore a file that names a token instead. A pattern that matched nothing
  // would have produced the same clean run above.
  assert.ok(pattern.test('const swatch = "#ff0000";'), 'the pattern recognises a hex colour');
  assert.equal(pattern.test('const swatch = "var(--rs-link)";'), false,
    'a file naming a token carries no literal');

  // The sweep really walked files, and really covered the product rather than a handful
  // of them - otherwise the exclusion above would be hiding an empty search.
  const covered = walkTree(ROOT, ['src', 'tests', 'scripts']);
  assert.ok(covered.length >= 40, `the search covered the repository's source; walked ${covered.length} files`);
  assert.ok(covered.includes(THEME_PATH), 'the stylesheet itself was among the files walked');
  assert.ok(covered.some((file) => file.startsWith(path.join(ROOT, 'src'))),
    'the search covered the product, not only its tests');
});

test('the stylesheet is plain: system fonts, no motion, no fetched asset, and it styles the pages', () => {
  // Arrange: the stylesheet's declarations, with the prose removed.
  const declarations = withoutComments(theme);

  // Act and assert: nothing that reaches off this machine and nothing that moves.
  assert.equal(/@import/i.test(declarations), false, 'the stylesheet imports nothing');
  assert.equal(/@font-face/i.test(declarations), false, 'the stylesheet downloads no font');
  assert.equal(/url\(/i.test(declarations), false, 'the stylesheet fetches no file');
  assert.equal(/https?:\/\//i.test(declarations), false, 'the stylesheet names no host');
  assert.equal(/transition|animation|@keyframes|scroll-behavior/i.test(declarations), false,
    'the stylesheet has no motion, so the reduced-motion preference has nothing to switch off');

  // Every font it names is one the operating system already provides.
  const tokens = new Map(parseDeclarations(tokenBlock(declarations).text)
    .map((declaration) => [declaration.name, declaration.value]));
  const systemFonts = new Set([
    'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'Noto Sans',
    'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'Courier New',
    'sans-serif', 'serif', 'monospace',
  ]);
  const stacks = [...declarations.matchAll(/(?:font-family|font-sans|font-mono)\s*:\s*([^;]+);/g)]
    .map((match) => match[1] ?? '');
  assert.ok(stacks.length > 0, 'the stylesheet declares at least one font stack');
  for (const stack of stacks) {
    const resolved = stack.replace(/var\((--rs-[a-z0-9-]+)\)/g, (whole, reference) => {
      assert.ok(tokens.has(/** @type {string} */ (reference)),
        `the stylesheet refers to ${reference}, which it never declares`);
      return tokens.get(/** @type {string} */ (reference)) ?? whole;
    });
    for (const name of resolved.split(',').map((entry) => entry.trim().replace(/^["']|["']$/g, ''))) {
      assert.ok(systemFonts.has(name), `the stylesheet names only fonts the operating system has: ${name}`);
    }
  }

  // And it is a stylesheet rather than a token file: the elements the pages emit are
  // addressed here, each with its rule.
  const styled = ['main', 'table', 'thead th', 'figure.chart', 'figcaption', '.skip-link',
    'a:focus-visible', 'caption', 'code'];
  for (const selector of styled) {
    const escaped = selector.replaceAll('.', String.raw`\.`);
    assert.ok(new RegExp(String.raw`(^|[\s,>])${escaped}[\s,{]`, 'm').test(declarations),
      `the stylesheet has a rule for ${selector}`);
  }
  // Every colour a rule uses is named through a token, so the rule cannot drift from
  // the value the contrast test computed.
  const properties = [...declarations.matchAll(/(^|[;{])\s*([a-z-]+)\s*:\s*([^;{}]+)/g)];
  for (const property of properties) {
    const name = property[2] ?? '';
    const value = property[3] ?? '';
    const isTokenDeclaration = name.startsWith('--rs-');
    if (isTokenDeclaration || !/#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/i.test(value)) continue;
    assert.fail(`the ${name} declaration names a colour literal instead of a token: ${value}`);
  }
  assert.ok([...properties].some((property) => (property[3] ?? '').includes('var(--rs-')),
    'the rules below the tokens refer to them by name');
});

/**
 * Every file under the named directories of the repository root, sorted. With no
 * directories named, the whole of `root` is walked.
 *
 * @param {string} root
 * @param {string[]} [directories] Directory names directly under `root`.
 * @returns {string[]}
 */
function walkTree(root, directories = []) {
  /** @type {string[]} */
  const found = [];
  const pending = directories.length === 0
    ? [root]
    : directories.map((name) => path.join(root, name));
  while (pending.length > 0) {
    const current = /** @type {string} */ (pending.shift());
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        pending.push(entryPath);
      } else if (entry.isFile()) {
        found.push(entryPath);
      }
    }
  }
  return found.sort();
}