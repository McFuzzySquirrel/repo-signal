import assert from 'node:assert/strict';
import test from 'node:test';

import { markBackfillRefused } from '../src/collect/lifecycle.js';
import { upsertDayFact } from '../src/db/day-series-repo.js';
import { openArchive, upsertRepository, withTransaction } from '../src/db/ops-repo.js';
import {
  assertNoCredentialMaterial, createCollectHome, outputLines as lines, rowCount as rows,
} from './helpers/collect-home.js';

// Every assertion drives the real entry point, `node src/cli.js report`, against a
// temporary home holding a real migrated archive. The fixture's GitHub stub is armed
// and its request log is asserted empty: this command must reach no host at all.
const OWNER = 'McFuzzySquirrel';
const NAME = 'skill-forge';
const REPO = `${OWNER}/${NAME}`;
const AT = '2026-10-02T09:00:00.000Z';
const END = '2026-10-02';
const HOLE = ['2026-09-21', '2026-09-22'];
const REFUSAL = 'GitHub HTTP 403: GitHub refused the star history for this token';

/** Fourteen traffic days ending {@link END}, oldest first. */
function window14() {
  return Array.from({ length: 14 }, (_, index) =>
    new Date(Date.parse(`${END}T00:00:00Z`) - (13 - index) * 86_400_000).toISOString().slice(0, 10));
}

/**
 * A home with the enrolled repository, a migrated archive, fourteen days of traffic
 * with a deliberate hole in `views`, and a star series that began before the window.
 * @param {import('node:test').TestContext} t
 * @param {{enrolled?: string[], hole?: boolean, refusal?: boolean, weeks?: boolean, lastSuccessAt?: string|null}} [options]
 */
async function archive(t, options = {}) {
  const f = await createCollectHome(t, { enrolled: options.enrolled ?? [REPO] });
  const db = await openArchive(f.databasePath);
  try {
    const enrolled = options.enrolled ?? [REPO];
    if (enrolled.length === 0) return f;
    const lastSuccessAt = options.lastSuccessAt === undefined ? AT : options.lastSuccessAt;
    upsertRepository(db, {
      id: 1, owner: OWNER, name: NAME, lastSeenAt: AT, enrolled: 1,
      ...(lastSuccessAt === null ? {} : { lastSuccessAt }),
    });
    if (options.hole !== false) {
      withTransaction(db, () => {
        for (const day of window14()) {
          /** @type {[string, number][]} */
          const metrics = [['clones', 9], ['unique-cloners', 4], ['views', 40], ['unique-visitors', 20]];
          for (const [metric, value] of metrics) {
            // The hole is only in `views`, so the other three metrics stay complete and
            // a report that named it for every metric would be caught here.
            if (metric === 'views' && HOLE.includes(day)) continue;
            upsertDayFact(db, { repositoryId: 1, metric, granularity: 'day', day, value, source: 'collected', collectedAt: AT });
          }
        }
        // Two stars, both before the reported window: a boundary, not a hole.
        /** @type {[string, number][]} */
        const stars = [['2026-08-05', 1], ['2026-08-06', 2]];
        for (const [day, value] of stars) {
          upsertDayFact(db, { repositoryId: 1, metric: 'stars', granularity: 'day', day, value, source: 'backfill', collectedAt: AT });
        }
        if (options.weeks === true) {
          for (const week of ['2026-09-20', '2026-09-27']) {
            upsertDayFact(db, { repositoryId: 1, metric: 'commit-activity', granularity: 'week', day: week, value: 4, source: 'backfill', collectedAt: AT });
          }
        }
      });
    }
    if (options.refusal === true) {
      withTransaction(db, () => markBackfillRefused({ db, repositoryId: 1, reason: REFUSAL, collectedAt: AT }));
    }
  } finally {
    db.close();
  }
  return f;
}

test('the bare command reports the run, one line per repository and the roll-up, and exits 0', async (t) => {
  const f = await archive(t);

  const result = await f.run(['report']);

  assert.equal(result.status, 0, result.stderr);
  assertNoCredentialMaterial(result, 'report');
  const printed = lines(result.stdout);
  assert.match(printed[0], /^repo-signal report: the enrolled set/);
  assert.match(result.stdout, /^home: .*home$/m, 'the home it read is named');
  assert.match(result.stdout, /^read at \d{4}-\d{2}-\d{2}T[\d:.]+Z \(\d{4}-\d{2}-\d{2}\)$/m);
  assert.match(result.stdout, /^run$/m);
  assert.match(result.stdout, /^ {2}never run: /m, "the run's own reason is printed, not a paraphrase");
  assert.match(result.stdout, /^ {2}unclosed runs: 0$/m);
  assert.match(result.stdout, /^repositories \(1\)$/m);
  assert.match(result.stdout, new RegExp(`^ {2}${OWNER}/${NAME} +stalled`, 'm'),
    'the state word is the repository own');
  assert.ok(result.stdout.includes(`last success ${AT}`), 'the recorded collection time is printed');
  assert.match(result.stdout, /roll-up: 1 stalled of 1 enrolled/);
  // The bare command is a digest: no coverage and no comparison.
  assert.doesNotMatch(result.stdout, /^coverage:/m);
  assert.doesNotMatch(result.stdout, /^change:/m);
});

test('a hole inside the range is named as a gap and a series that began earlier is named as a boundary', async (t) => {
  const f = await archive(t);

  const result = await f.run(['report', '--repo', REPO, '--from', '2026-09-19', '--to', END]);

  assert.equal(result.status, 0, result.stderr);
  assertNoCredentialMaterial(result, 'report --repo');
  const coverage = result.stdout.slice(result.stdout.indexOf('coverage:'));
  // The hole is named, and only on the metric that has it.
  assert.match(coverage, /^ {2}views +12 of 14 days stored; the series begins 2026-09-19, gaps 2026-09-21, 2026-09-22$/m);
  for (const metric of ['clones', 'unique-cloners', 'unique-visitors']) {
    assert.match(coverage, new RegExp(`^ {2}${metric} +14 of 14 days stored`, 'm'),
      `${metric} is complete and must not be shown a gap`);
  }
  // The star series began before the window: a boundary, never a gap, and never a zero.
  assert.match(coverage, /^ {2}stars +no stored days in the 14-day range, the series begins 2026-08-05, before this range$/m);
  const starsLine = coverage.split('\n').find((line) => line.includes('stars ')) ?? '';
  assert.equal(/gaps/.test(starsLine), false, 'a boundary is never reported as a gap');
  assert.equal(/ 0 /.test(starsLine), false, 'an unmeasured series is never reported as zero');
});

test('a metric the archive holds nothing for says so rather than reporting a zero', async (t) => {
  const f = await archive(t, { hole: false });

  const result = await f.run(['report', '--repo', REPO, '--from', '2026-09-19', '--to', END]);

  assert.equal(result.status, 0, result.stderr);
  const coverage = result.stdout.slice(result.stdout.indexOf('coverage:'));
  // commit-activity is never seeded here, and the archive holds no day for it at all.
  assert.match(coverage, /^ {2}commit-activity +no stored weeks in the selected range$/m);
  assert.equal(/commit-activity.*\b0\b/.test(coverage), false, 'no zero stands in for an unstored metric');
});

test('a weekly metric is counted in weeks, never against a daily calendar', async (t) => {
  const f = await archive(t, { weeks: true });

  const result = await f.run(['report', '--repo', REPO, '--from', '2026-09-19', '--to', END]);

  assert.equal(result.status, 0, result.stderr);
  const coverage = result.stdout.slice(result.stdout.indexOf('coverage:'));
  assert.match(coverage, /^ {2}commit-activity +2 weeks stored$/m);
  assert.equal(/commit-activity.*\b14\b/.test(coverage), false,
    'a weekly series is not measured against the range day count');
});

test('a recorded backfill refusal is named so the absence it explains is not read as a zero', async (t) => {
  const f = await archive(t, { refusal: true });

  const result = await f.run(['report', '--repo', REPO, '--from', '2026-09-19', '--to', END]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^ {2}star history: absent . ${REFUSAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('the change block prints the sentences the insight modules composed', async (t) => {
  const f = await archive(t);

  const result = await f.run(['report', '--repo', REPO, '--from', '2026-09-19', '--to', END]);

  assert.equal(result.status, 0, result.stderr);
  const change = result.stdout.slice(result.stdout.indexOf('change:'));
  assert.match(change, /^ {2}clones$/m);
  assert.match(change, /^ {4}seven-day {7}clones recorded 63 over the last 7 days of the selected range/m);
  assert.match(change, /^ {4}week-over-week {2}clones recorded 63 over the last complete week/m);
  // The hole falls in the earlier window, so the comparison refuses rather than
  // summing over fewer days than it claims.
  assert.match(change, /^ {4}seven-day {7}insufficient data: views holds no stored value for 2026-09-21 and 2026-09-22/m);
  assert.equal(/views.*\b0%/.test(change), false, 'no comparison is reported over a window with a hole');
});

test('the default range spans the fourteen days ending today', async (t) => {
  const f = await archive(t);

  const result = await f.run(['report', '--repo', REPO]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^coverage: .* \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/m);
  const [, from, to] = /coverage: \S+ (\S+) to (\S+)$/m.exec(result.stdout) ?? [];
  assert.equal(to, new Date().toISOString().slice(0, 10), 'the range ends today');
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  assert.equal(span, 14, 'the default window is the span of GitHub own traffic window');
});

test('an archive in which nothing is healthy still exits 0', async (t) => {
  const f = await archive(t, { lastSuccessAt: '2026-09-01T00:00:00.000Z' });

  const result = await f.run(['report']);

  // A report that read the archive succeeded. The state words are the news, and a
  // scheduled run must not fail because a repository needs attention.
  assert.equal(result.status, 0, result.stderr);
  assertNoCredentialMaterial(result, 'unhealthy report');
  assert.match(result.stdout, /roll-up: 1 stalled of 1 enrolled/);
});

test('a home with nothing enrolled reports its own roll-up rather than an error', async (t) => {
  const f = await archive(t, { enrolled: [] });

  const result = await f.run(['report']);

  assert.equal(result.status, 0, result.stderr);
  assertNoCredentialMaterial(result, 'empty home');
  assert.match(result.stdout, /^repositories \(0\)$/m);
  assert.match(result.stdout, /roll-up: empty: /m);
});

test('the report reaches no host and reads no credential', async (t) => {
  const f = await archive(t, { refusal: true });

  const result = await f.run(['report', '--repo', REPO]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.stub.requests(), [],
    'report made no request of any kind, so it contacted no host');
  assertNoCredentialMaterial(result, 'report');
  assert.equal(result.stdout.includes('credentials.json'), false,
    'the report names no credential path');
});

test('the printed text carries no score, grade, threshold or verdict', async (t) => {
  const f = await archive(t, { refusal: true });

  const result = await f.run(['report', '--repo', REPO, '--from', '2026-09-19', '--to', END]);

  assert.equal(result.status, 0, result.stderr);
  for (const word of [
    /\bscore\b/i, /\bgrade[ds]?\b/i, /\bthreshold\b/i, /\bverdict\b/i,
    /\boutperform/i, /\bunderperform/i, /\btrend(ing|s)? (up|down)\b/i, /\bhealth(y|ier)\b/i,
  ]) {
    assert.doesNotMatch(result.stdout, word, `the report must not claim ${String(word)}`);
  }
});

for (const args of [
  ['--nope'],
  ['--repo'],
  ['--repo', 'not-a-pair'],
  ['--repo', 'nobody/nothing'],
  ['--from', 'nonsense'],
  ['--to', '2026-13-45'],
  ['--from', '2026-10-02', '--to', '2026-09-19'],
  ['--repo', `${OWNER}/${NAME}`, '--repo', `${OWNER}/${NAME}`],
]) {
  test(`report ${args.join(' ')} is a usage error and writes nothing`, async (t) => {
    const f = await archive(t);

    const result = await f.run(['report', ...args]);

    assert.equal(result.status, 2, String(result.stdout) + String(result.stderr));
    assert.match(result.stderr, /Usage:/);
    assertNoCredentialMaterial(result, `usage ${args.join(' ')}`);
    f.archive((db) => {
      assert.equal(rows(db, 'runs'), 0, 'a usage error opens no run');
      assert.equal(rows(db, 'heartbeats'), 0, 'a usage error writes no heartbeat');
    });
  });
}

test('a --repo naming a repository outside the enrolled set names the set that would work', async (t) => {
  const f = await archive(t);

  const result = await f.run(['report', '--repo', 'nobody/nothing']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /report --repo nobody\/nothing is not an enrolled repository/);
  assert.match(result.stderr, new RegExp(`the enrolled set is ${OWNER}/${NAME}`));
});