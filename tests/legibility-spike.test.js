import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPIKE_RELATIVE_PATH = path.join('spikes', 'dashboard-legibility.html');
const SPIKE_PATH = path.join(REPO_ROOT, SPIKE_RELATIVE_PATH);
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const DAY_COUNT = 14;
const PANEL_SHAPES = ['spiking', 'flat', 'decaying'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'docs', '.opencode', 'spikes']);
/**
 * Extensions that can wire the spike into the product if they name it. Prose
 * files are excluded on purpose: a brief or a feature document may describe the
 * spike, but a module, a script or a manifest must not.
 */
const WIRABLE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json', '.css']);

/** @type {string} */
const spike = readFileSync(SPIKE_PATH, 'utf8');

/**
 * Every source file in a directory tree, or an empty list when the tree does
 * not exist yet. `src/` is created by a later task, so an absent tree is a
 * legal state for this test rather than a reason to skip it.
 * @param {string} directory Absolute path to walk.
 * @returns {string[]} Absolute paths of the files found, sorted.
 */
function collectFiles(directory) {
  if (!existsSync(directory)) return [];
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      found.push(...collectFiles(entryPath));
    } else if (entry.isFile()) {
      found.push(entryPath);
    }
  }
  return found.sort();
}

/**
 * The markup of one panel, from its own opening `section` to the next panel or
 * the end of the panel grid, so an assertion about one panel cannot be
 * satisfied by another panel's numbers.
 * @param {string} shape One of the three panel shapes.
 * @returns {string}
 */
function panelMarkup(shape) {
  const panel = spike.match(new RegExp(`<section class="panel" data-panel="${shape}"[\\s\\S]*?(?=<section class="panel"|</div>\\s*</section>)`));
  assert.notEqual(panel, null, `no panel section for the ${shape} history`);
  return panel?.[0] ?? '';
}

/**
 * One `<tr>...</tr>` of a panel's data table, or the empty string when the
 * panel has no such row.
 * @param {string} markup Markup of one panel.
 * @param {string} day ISO calendar day to look for.
 * @returns {string}
 */
function tableRowFor(markup, day) {
  const rows = markup.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  return rows.find((row) => row.includes(`<th scope="row">${day}</th>`)) ?? '';
}

/**
 * @param {string} markup Markup of one panel.
 * @param {string} header A `th` label from the panel's table head.
 * @returns {string[]} The text of every stored body cell under that column.
 */
function columnValues(markup, header) {
  const head = markup.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? '';
  const labels = [...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((match) => (match[1] ?? '').trim());
  const index = labels.indexOf(header);
  assert.notEqual(index, -1, `the panel table has no ${header} column`);
  const body = markup.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? '';
  /** @type {string[]} */
  const values = [];
  for (const row of body.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    if (row.includes('class="gap-row"')) continue;
    // A body row carries the day in a `th`, so the data cells sit one place to
    // the left of the head cell they belong to.
    const leadingHeaders = (row.match(/<th/g) ?? []).length;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => (match[1] ?? '').trim());
    values.push(cells[index - leadingHeaders] ?? '');
  }
  return values;
}

test('the spike file exists, is a readable file, and is not a product module', () => {
  assert.equal(existsSync(SPIKE_PATH), true, `${SPIKE_RELATIVE_PATH} does not exist`);
  assert.equal(statSync(SPIKE_PATH).isFile(), true, `${SPIKE_RELATIVE_PATH} is not a file`);
  assert.ok(spike.length > 4000, `the spike page is only ${spike.length} characters, which is too short to carry three panels`);
  assert.ok(spike.startsWith('<!DOCTYPE html>'), 'the spike page is not a complete HTML document');
  assert.ok(spike.trimEnd().endsWith('</html>'), 'the spike page is truncated');
  assert.equal(existsSync(path.join(SRC_ROOT, 'spikes')), false, 'the spike is not under src/');
});

test('the spike states on its face that it is a throwaway design artifact', () => {
  assert.match(spike, /throwaway design artifact/i);
  assert.match(spike, /not the RepoSignal dashboard/i);
  assert.match(spike, /Nothing under <code>src<\/code> imports it/i);
  assert.match(spike, /is safe to delete/i);
  assert.match(spike, /invented/i);
  assert.match(spike, /not wired into the product|no command serves it/i);
});

test('the spike renders exactly three panels, one per shaped history', () => {
  const panels = [...spike.matchAll(/<section class="panel" data-panel="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(panels, PANEL_SHAPES);
  for (const shape of PANEL_SHAPES) {
    const markup = panelMarkup(shape);
    assert.match(markup, /<h3[^>]*>/, `the ${shape} panel has no heading`);
    assert.match(markup, /Shape: [a-z]+\. Review vocabulary only\./, `the ${shape} panel does not label its shape as review vocabulary`);
    assert.equal(
      (markup.match(/<svg /g) ?? []).length,
      2,
      `the ${shape} panel must carry one acquisition chart and one interest chart`,
    );
    assert.equal((markup.match(/<table>/g) ?? []).length, 1, `the ${shape} panel must carry exactly one data table`);
  }
});

test('every panel carries all of its data inline, with no fetch and no data attribute standing in for it', () => {
  for (const shape of PANEL_SHAPES) {
    const markup = panelMarkup(shape);
    for (let day = 1; day <= DAY_COUNT; day += 1) {
      const iso = `2026-03-${String(day).padStart(2, '0')}`;
      const row = tableRowFor(markup, iso);
      assert.notEqual(row, '', `the ${shape} panel table has no row for ${iso}, so its data is not inline`);
    }
    const clones = columnValues(markup, 'Clones');
    const views = columnValues(markup, 'Views');
    const cloners = columnValues(markup, 'Unique cloners');
    assert.equal(clones.length, DAY_COUNT - 1, `the ${shape} panel states ${clones.length} clone days, expected 13 stored days`);
    for (const value of [...clones, ...views, ...cloners]) {
      assert.match(value, /^\d+$/, `the ${shape} panel table holds "${value}" where a stored number belongs`);
    }
    assert.ok(new Set(clones).size > 1, `the ${shape} panel shows a single repeated value, which is not a shaped history`);
  }
});

test('each panel names its gap day in text, in the table row and beside the chart', () => {
  /** @type {Record<string, string>} */
  const expectedGapDays = { spiking: '2026-03-05', flat: '2026-03-06', decaying: '2026-03-08' };
  for (const shape of PANEL_SHAPES) {
    const markup = panelMarkup(shape);
    const gapDay = expectedGapDays[shape];
    const gapRow = tableRowFor(markup, gapDay);
    assert.match(gapRow, /class="gap-row"/, `the ${shape} panel has no gap row for ${gapDay}`);
    assert.match(
      gapRow,
      /No stored observation on this day/,
      `the ${shape} panel's gap row must state the absence in words, not leave an empty cell`,
    );
    assert.equal(
      (markup.match(/class="gap-row"/g) ?? []).length,
      1,
      `the ${shape} panel must show exactly one gap day`,
    );
    assert.match(
      markup,
      new RegExp(`Days with no stored observation in this window: ${gapDay}\\.`),
      `the ${shape} panel does not name ${gapDay} in the text beside its numbers`,
    );
    assert.doesNotMatch(
      gapRow,
      /<td[^>]*>\s*\d+\s*<\/td>/,
      `the ${shape} panel's gap day must not carry a number, because a substituted zero is a claim the archive does not support`,
    );
    assert.match(
      markup,
      /13 stored days of 14 calendar days/,
      `the ${shape} panel must state that it holds 13 stored days of 14, so the missing day is not hidden`,
    );
  }
});

test('each chart breaks the line at the gap day instead of bridging it', () => {
  const firstDayX = 58;
  const dayWidth = 34;
  for (const shape of PANEL_SHAPES) {
    const markup = panelMarkup(shape);
    const gapRule = markup.match(/<line class="gap-rule" x1="(\d+)"/);
    assert.notEqual(gapRule, null, `the ${shape} panel does not mark its gap day on the chart`);
    const gapX = Number(gapRule?.[1]);
    assert.equal(
      (gapX - firstDayX) % dayWidth,
      0,
      `the ${shape} panel's gap rule does not stand on a day of the window`,
    );
    const gapIndex = (gapX - firstDayX) / dayWidth;
    const polylines = [...markup.matchAll(/<polyline class="series-line" points="([^"]*)"/g)].map((match) =>
      (match[1] ?? '').split(' ').filter((point) => point.length > 0),
    );
    assert.equal(polylines.length, 4, `the ${shape} panel must draw two strokes per chart, so four in total`);
    /** @type {number[]} */
    const drawn = [];
    for (const points of polylines) {
      const xs = points.map((point) => Number(point.split(',')[0]));
      assert.ok(xs.length > 0, `the ${shape} panel drew an empty stroke`);
      drawn.push(...xs);
      for (let index = 1; index < xs.length; index += 1) {
        assert.equal(
          xs[index] - xs[index - 1],
          dayWidth,
          `a ${shape} stroke skips or bridges a day: the step between consecutive points must be one day wide`,
        );
      }
    }
    const expected = [];
    for (let index = 0; index < DAY_COUNT; index += 1) {
      if (index === gapIndex) continue;
      expected.push(firstDayX + dayWidth * index);
    }
    assert.deepEqual(
      [...new Set(drawn)].sort((left, right) => left - right),
      expected,
      `the ${shape} panel's strokes must cover every stored day and skip only the gap day`,
    );
    assert.ok(
      polylines.some((points) => Number(points[0]?.split(',')[0]) > gapX),
      `the ${shape} panel has no stroke after its gap day, so the gap truncated the series`,
    );
  }
});

test('the spike carries no external reference of any kind', () => {
  assert.doesNotMatch(spike, /https?:/i, 'the spike references an absolute external URL');
  assert.doesNotMatch(spike, /\/\//, 'the spike references a protocol-relative URL');
  assert.doesNotMatch(spike, /@import/i, 'the spike imports a stylesheet');
  assert.doesNotMatch(spike, /url\(/i, 'the spike references an asset from CSS');
  assert.doesNotMatch(spike, /<link\b/i, 'the spike links an external stylesheet');
  assert.doesNotMatch(spike, /<base\b/i, 'the spike declares a base URL');
  assert.doesNotMatch(spike, /@font-face/i, 'the spike declares a font face');
  assert.doesNotMatch(spike, /<img\b/i, 'the spike loads an image');
  assert.doesNotMatch(spike, /<iframe\b/i, 'the spike embeds a frame');
  assert.doesNotMatch(spike, /\bsrc\s*=/i, 'the spike loads a subresource');
  for (const scheme of ['fetch(', 'XMLHttpRequest', 'importScripts', 'sendBeacon', 'EventSource', 'WebSocket']) {
    assert.ok(!spike.includes(scheme), `the spike performs a network call through ${scheme}`);
  }
});

test('the spike has no script, no inline handler, no motion and no charting library', () => {
  assert.doesNotMatch(spike, /<script\b/i, 'the spike contains a script');
  assert.doesNotMatch(spike, /\son[a-z]+\s*=\s*"/i, 'the spike contains an inline event handler attribute');
  assert.doesNotMatch(spike, /javascript:/i, 'the spike contains a javascript: URL');
  for (const motion of ['@keyframes', 'transition:', 'animation:', 'animate ', 'requestAnimationFrame', '<video', '<audio']) {
    assert.ok(!spike.includes(motion), `the spike contains motion or media through ${motion.trim()}`);
  }
  // With no script element and no subresource attribute, nothing can be loaded
  // at runtime, so a charting library could only appear as a host it is fetched
  // from or as a vendored file it is bundled into. Both are named here.
  for (const host of ['cdn', 'unpkg', 'jsdelivr', 'cdnjs', 'googleapis', 'gstatic', 'bundle', 'vendor']) {
    assert.ok(!spike.toLowerCase().includes(host), `the spike names a load host or a vendored bundle: ${host}`);
  }
  assert.doesNotMatch(spike, /\brequire\s*\(/, 'the spike loads a module');
  assert.equal((spike.match(/<svg /g) ?? []).length, 6, 'the spike must draw its six charts with hand-rolled SVG');
  assert.equal((spike.match(/<polyline /g) ?? []).length, 12, 'the spike must draw its own strokes, not an embedded image');
});

test('the spike is referenced by no file under src, and by no code or configuration in the repository', () => {
  const needle = 'dashboard-legibility';
  const sources = collectFiles(SRC_ROOT);
  for (const file of sources) {
    const contents = readFileSync(file, 'utf8');
    assert.ok(
      !contents.includes(needle) && !contents.includes('spikes/'),
      `${path.relative(REPO_ROOT, file)} references the spike, so the spike is wired into the product`,
    );
  }
  // Prose may name the spike - the agent briefs and the feature documents do -
  // but code and configuration may not, because a reference there is what would
  // make the artifact part of the product.
  const wiring = collectFiles(REPO_ROOT).filter(
    (file) =>
      file !== SPIKE_PATH &&
      file !== fileURLToPath(import.meta.url) &&
      !file.startsWith(SRC_ROOT + path.sep) &&
      WIRABLE_EXTENSIONS.has(path.extname(file)),
  );
  const referencing = wiring.filter((file) => readFileSync(file, 'utf8').includes(needle));
  assert.deepEqual(
    referencing.map((file) => path.relative(REPO_ROOT, file)),
    [],
    'no source or configuration file may name the spike, so the product can never load it',
  );
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const manifestText = JSON.stringify(manifest);
  assert.ok(!manifestText.includes(needle), 'package.json names the spike');
  assert.ok(!manifestText.includes('spikes/'), 'package.json points at the spikes directory');
});

test('the spike states no verdict and names its own limits', () => {
  for (const verdict of [
    'adoption score',
    'composite ranking',
    'anomaly',
    'threshold verdict',
    'popularity score',
    'health score',
  ]) {
    assert.ok(!spike.toLowerCase().includes(verdict), `the spike claims a ${verdict}`);
  }
  assert.match(spike, /a clone is a clone/i);
  for (const shape of PANEL_SHAPES) {
    assert.match(
      panelMarkup(shape),
      /Not stated\./,
      `the ${shape} panel must state that it does not state a comparison, rather than implying one`,
    );
  }
});
