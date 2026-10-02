import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { backfillStars, cumulativeStarDays } from '../src/backfill/stars.js';
import { readDaySeries } from '../src/db/day-series-repo.js';
import { openArchive, upsertRepository } from '../src/db/ops-repo.js';
import { resolveHomePaths } from '../src/paths.js';

const collectedAt = '2026-10-01T00:00:00.000Z';
const range = { repositoryId: 1, metric: 'stars', granularity: /** @type {const} */ ('day'),
  from: '2020-01-01', to: '2030-01-01' };

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-backfill-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  upsertRepository(db, { id: 1, owner: 'owner', name: 'archive', lastSeenAt: collectedAt, enrolled: 1 });
  return db;
}

/** @param {Array<{day: string, counts: number}>} pages */
function fakeClient(pages) {
  /** @type {Array<{repo: string, page: number, size: number}>} */
  const calls = [];
  return {
    calls,
    starsClient: {
      /** @param {string} repo @param {(entries: Array<Record<string, unknown>>, page: number, endpoint: string) => void} onPage */
      async stargazerStars(repo, onPage) {
        let entries = 0;
        let page = 0;
        for (const { day, counts } of pages) {
          page += 1;
          const batch = Array.from({ length: counts }, (_, i) => ({
            user: { login: `u${page}-${i}` }, starred_at: `${day}T12:00:00Z`, extra: 'passthrough',
          }));
          entries += batch.length;
          calls.push({ repo, page, size: batch.length });
          onPage(batch, page, `/repos/owner/archive/stargazers?page=${page}`);
        }
        return { pages: page, entries };
      },
    },
  };
}

test('three stars on two distinct days produce two rows whose values are the running total', async (t) => {
  const db = await fixture(t);
  const { starsClient } = fakeClient([
    { day: '2026-03-01', counts: 2 },
    { day: '2026-03-04', counts: 1 },
  ]);
  const summary = await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient, collectedAt });
  assert.deepEqual(summary, { pages: 2, entries: 3, rows: 2 });
  const rows = readDaySeries(db, range);
  assert.deepEqual(rows.map((row) => [row.day, row.value]), [
    ['2026-03-01', 2],
    ['2026-03-04', 3],
  ]);
});

test('no row is written for a day before the first star and a multi-day gap is not filled', async (t) => {
  const db = await fixture(t);
  const { starsClient } = fakeClient([
    { day: '2026-05-10', counts: 1 },
    { day: '2026-05-20', counts: 2 },
  ]);
  await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient, collectedAt });
  const rows = readDaySeries(db, range);
  assert.deepEqual(rows.map((row) => row.day), ['2026-05-10', '2026-05-20']);
  assert.equal(rows[0].value, 1);
  assert.equal(rows[1].value, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM day_series WHERE day < '2026-05-10'").get()?.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM day_series WHERE day = '2026-05-15'").get()?.n, 0);
});

test('a repository with no stars produces no rows and no error', async (t) => {
  const db = await fixture(t);
  const { starsClient } = fakeClient([]);
  const summary = await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient, collectedAt });
  assert.deepEqual(summary, { pages: 0, entries: 0, rows: 0 });
  assert.deepEqual(readDaySeries(db, range), []);
});

test('running the backfill twice over the same input leaves the row count unchanged', async (t) => {
  const db = await fixture(t);
  const first = fakeClient([
    { day: '2026-07-01', counts: 3 },
    { day: '2026-07-03', counts: 1 },
  ]);
  await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient: first.starsClient, collectedAt });
  const countAfterFirst = db.prepare('SELECT count(*) AS n FROM day_series').get()?.n;
  const second = fakeClient([
    { day: '2026-07-01', counts: 3 },
    { day: '2026-07-03', counts: 1 },
  ]);
  await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient: second.starsClient, collectedAt });
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_series').get()?.n, countAfterFirst);
  assert.deepEqual(readDaySeries(db, range).map((row) => [row.day, row.value]), [
    ['2026-07-01', 3],
    ['2026-07-03', 4],
  ]);
});

test('every written row carries source backfill and a collection timestamp', async (t) => {
  const db = await fixture(t);
  const { starsClient } = fakeClient([{ day: '2026-08-02', counts: 2 }]);
  await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient, collectedAt });
  const rows = readDaySeries(db, range);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'backfill');
  assert.equal(rows[0].collectedAt, collectedAt);
  assert.equal(rows[0].granularity, 'day');
  assert.equal(rows[0].metric, 'stars');
});

test('every stargazer page is consumed and unknown fields pass through untouched', async (t) => {
  const db = await fixture(t);
  const { starsClient, calls } = fakeClient([
    { day: '2026-09-01', counts: 1 },
    { day: '2026-09-01', counts: 1 },
    { day: '2026-09-02', counts: 1 },
  ]);
  const summary = await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient, collectedAt });
  assert.deepEqual(calls.map((call) => [call.repo, call.page, call.size]), [
    ['owner/archive', 1, 1],
    ['owner/archive', 2, 1],
    ['owner/archive', 3, 1],
  ]);
  assert.deepEqual(summary, { pages: 3, entries: 3, rows: 2 });
  assert.deepEqual(cumulativeStarDays([{ starred_at: '2026-09-01T00:00:00Z', other: 1 }]), [
    { day: '2026-09-01', value: 1 },
  ]);
});
