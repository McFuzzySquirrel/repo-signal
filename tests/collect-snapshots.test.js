import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  collectSnapshots, writeSnapshotCaptures, POPULAR_PATHS_KIND, REFERRERS_KIND,
} from '../src/collect/snapshots.js';
import { appendSnapshot, readLatestCapture, readSnapshotHistory } from '../src/db/snapshot-repo.js';
import { appendRun, openArchive, upsertRepository, withTransaction } from '../src/db/ops-repo.js';
import { resolveHomePaths } from '../src/paths.js';

// Referrer and popular-path shapes follow https://docs.github.com/en/rest/metrics/traffic
// as mapped by src/github/traffic-client.js. The client is injected, so no test opens a
// socket or reaches api.github.com.
const first = '2026-10-01T00:00:00.000Z';
const second = '2026-10-01T06:30:00.000Z';
const repo = 'owner/archive';

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-collect-snapshots-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  upsertRepository(db, { id: 1, owner: 'owner', name: 'archive', lastSeenAt: first, enrolled: 1 });
  upsertRepository(db, { id: 2, owner: 'owner', name: 'other', lastSeenAt: first });
  appendRun(db, { id: 'run-1', startedAt: first });
  appendRun(db, { id: 'run-2', startedAt: second });
  return db;
}

/**
 * @param {Array<[string, number, number]>} referrers
 * @returns {import('../src/github/traffic-client.js').ReferrerRecord[]}
 */
function referrerList(referrers) {
  return referrers.map(([referrer, count, uniques]) => ({ referrer, count, uniques }));
}

/**
 * @param {Array<[string, string, number, number]>} paths
 * @returns {import('../src/github/traffic-client.js').PopularPathRecord[]}
 */
function pathList(paths) {
  return paths.map(([entryPath, title, count, uniques]) => ({ path: entryPath, title, count, uniques }));
}

/**
 * @param {{referrers?: import('../src/github/traffic-client.js').ReferrerRecord[], popularPaths?: import('../src/github/traffic-client.js').PopularPathRecord[]}} payload
 */
function fakeListClient(payload) {
  /** @type {string[]} */
  const calls = [];
  /** @type {import('../src/collect/snapshots.js').ListClient} */
  const trafficClient = {
    referrers: async (name) => {
      calls.push(`${name} referrers`);
      return payload.referrers ?? [];
    },
    popularPaths: async (name) => {
      calls.push(`${name} popularPaths`);
      return payload.popularPaths ?? [];
    },
  };
  return { calls, trafficClient };
}

/** @param {import('node:sqlite').DatabaseSync} db @param {import('../src/db/snapshot-repo.js').SnapshotKind} kind */
function storedRows(db, kind) {
  return /** @type {number} */ (db.prepare('SELECT count(*) AS n FROM snapshots WHERE kind=?')
    .get(kind)?.n);
}

const firstReferrers = referrerList([['example.org', 12, 7], ['news.example', 4, 3]]);
const firstPaths = pathList([['/', 'RepoSignal', 30, 18], ['/docs/guide', 'Guide & Setup', 9, 5]]);

test('a first collection appends one row per returned entry with its run and capture time', async (t) => {
  const db = await fixture(t);
  const { calls, trafficClient } = fakeListClient({ referrers: firstReferrers, popularPaths: firstPaths });
  const summary = await collectSnapshots({
    db, repositoryId: 1, repo, runId: 'run-1', trafficClient, collectedAt: first,
  });

  assert.deepEqual(calls, [`${repo} referrers`, `${repo} popularPaths`]);
  assert.deepEqual(summary, { referrers: 2, popularPaths: 2, rows: 4 });
  assert.equal(storedRows(db, REFERRERS_KIND), 2);
  assert.equal(storedRows(db, POPULAR_PATHS_KIND), 2);

  assert.deepEqual(readSnapshotHistory(db, 1, REFERRERS_KIND).map(
    (row) => [row.runId, row.kind, row.label, row.title, row.count, row.uniques, row.position, row.collectedAt]), [
    ['run-1', REFERRERS_KIND, 'example.org', null, 12, 7, 0, first],
    ['run-1', REFERRERS_KIND, 'news.example', null, 4, 3, 1, first],
  ]);
  // The popular-path title and its numbers are stored exactly as returned.
  assert.deepEqual(readSnapshotHistory(db, 1, POPULAR_PATHS_KIND).map(
    (row) => [row.label, row.title, row.count, row.uniques, row.position, row.runId, row.collectedAt]), [
    ['/', 'RepoSignal', 30, 18, 0, 'run-1', first],
    ['/docs/guide', 'Guide & Setup', 9, 5, 1, 'run-1', first],
  ]);
  // Every row names the run that observed it and the instant it was captured.
  for (const row of [...readSnapshotHistory(db, 1, REFERRERS_KIND), ...readSnapshotHistory(db, 1, POPULAR_PATHS_KIND)]) {
    assert.equal(row.runId, 'run-1');
    assert.equal(row.collectedAt, first);
    // These lists are undated aggregates; a capture never gains a day dimension.
    assert.ok(!('day' in row));
  }
  assert.ok(!db.prepare('PRAGMA table_info(snapshots)').all().some((column) => column.name === 'day'));
  // Another repository is untouched by this repository's capture.
  assert.equal(db.prepare('SELECT count(*) AS n FROM snapshots WHERE repository_id=2').get()?.n, 0);
});

test('two runs on the same day append two captures that both survive with distinct times', async (t) => {
  const db = await fixture(t);
  const { trafficClient: firstRun } = fakeListClient({ referrers: firstReferrers, popularPaths: firstPaths });
  await collectSnapshots({ db, repositoryId: 1, repo, runId: 'run-1', trafficClient: firstRun, collectedAt: first });

  // The same referrer and path return again, uncorrected, later the same day.
  const repeatReferrers = referrerList([['example.org', 15, 8], ['news.example', 4, 3]]);
  const repeatPaths = pathList([['/', 'RepoSignal', 41, 22], ['/docs/guide', 'Guide & Setup', 9, 5]]);
  const { trafficClient: secondRun } = fakeListClient({ referrers: repeatReferrers, popularPaths: repeatPaths });
  const summary = await collectSnapshots({
    db, repositoryId: 1, repo, runId: 'run-2', trafficClient: secondRun, collectedAt: second,
  });

  assert.deepEqual(summary, { referrers: 2, popularPaths: 2, rows: 4 });
  assert.equal(storedRows(db, REFERRERS_KIND), 4);
  assert.equal(storedRows(db, POPULAR_PATHS_KIND), 4);

  const history = readSnapshotHistory(db, 1, REFERRERS_KIND);
  assert.deepEqual(history.map((row) => [row.runId, row.label, row.count, row.position, row.collectedAt]), [
    ['run-1', 'example.org', 12, 0, first],
    ['run-1', 'news.example', 4, 1, first],
    ['run-2', 'example.org', 15, 0, second],
    ['run-2', 'news.example', 4, 1, second],
  ]);
  // Two captures of one referrer, not one merged entry and not one overwritten entry.
  const exampleOrg = history.filter((row) => row.label === 'example.org');
  assert.equal(exampleOrg.length, 2);
  assert.deepEqual(exampleOrg.map((row) => row.collectedAt), [first, second]);
  assert.notEqual(exampleOrg[0].id, exampleOrg[1].id);
  assert.notEqual(exampleOrg[0].collectedAt, exampleOrg[1].collectedAt);

  // The newest capture reads whole, and never mixes in the older list.
  assert.deepEqual(readLatestCapture(db, 1, REFERRERS_KIND).map((row) => [row.runId, row.count, row.position]), [
    ['run-2', 15, 0], ['run-2', 4, 1],
  ]);
  assert.ok(readLatestCapture(db, 1, POPULAR_PATHS_KIND).every((row) => row.runId === 'run-2' && row.collectedAt === second));
});

test('a short response writes exactly the returned entries and is never padded to ten', async (t) => {
  const db = await fixture(t);
  const { trafficClient } = fakeListClient({
    referrers: referrerList([['one.example', 3, 2], ['two.example', 2, 1], ['three.example', 1, 1]]),
    popularPaths: pathList([['/only', 'Only', 5, 4]]),
  });
  const summary = await collectSnapshots({
    db, repositoryId: 1, repo, runId: 'run-1', trafficClient, collectedAt: first,
  });

  assert.deepEqual(summary, { referrers: 3, popularPaths: 1, rows: 4 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM snapshots').get()?.n, 4);
  assert.equal(storedRows(db, REFERRERS_KIND), 3);
  assert.deepEqual(readLatestCapture(db, 1, REFERRERS_KIND).map((row) => [row.label, row.position, row.count, row.uniques]), [
    ['one.example', 0, 3, 2], ['two.example', 1, 2, 1], ['three.example', 2, 1, 1],
  ]);
  assert.deepEqual(readLatestCapture(db, 1, POPULAR_PATHS_KIND).map((row) => [row.label, row.title, row.count]), [
    ['/only', 'Only', 5],
  ]);
});

test('empty lists append nothing, report zero and capture cleanly on the next run', async (t) => {
  const db = await fixture(t);
  const { calls, trafficClient } = fakeListClient({ referrers: [], popularPaths: [] });
  const summary = await collectSnapshots({
    db, repositoryId: 1, repo, runId: 'run-1', trafficClient, collectedAt: first,
  });

  assert.deepEqual(calls, [`${repo} referrers`, `${repo} popularPaths`]);
  assert.deepEqual(summary, { referrers: 0, popularPaths: 0, rows: 0 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM snapshots').get()?.n, 0);
  assert.deepEqual(readSnapshotHistory(db, 1, REFERRERS_KIND), []);

  const { trafficClient: retry } = fakeListClient({ referrers: firstReferrers, popularPaths: firstPaths });
  const captured = await collectSnapshots({
    db, repositoryId: 1, repo, runId: 'run-2', trafficClient: retry, collectedAt: second,
  });
  assert.deepEqual(captured, { referrers: 2, popularPaths: 2, rows: 4 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM snapshots').get()?.n, 4);
});

test('a failure between two appends leaves no half-written capture and no merged retry', async (t) => {
  const cases = /** @type {Array<[string, {referrers?: import('../src/github/traffic-client.js').ReferrerRecord[], popularPaths?: import('../src/github/traffic-client.js').PopularPathRecord[]}, RegExp]>} */ ([
    ['a fractional count', { popularPaths: [firstPaths[0], { path: '/docs', title: 'Docs', count: 2.5, uniques: 1 }] },
      /popular paths entry 1 must carry a non-negative integer count/],
    ['a missing title', { popularPaths: [firstPaths[0], { path: '/docs', count: 4, uniques: 2 }] },
      /popular paths entry 1 must carry the title GitHub returned/],
    ['a missing path', { popularPaths: [firstPaths[0], { title: 'Docs', count: 4, uniques: 2 }] },
      /popular paths entry 1 must carry a non-empty path/],
    ['an empty referrer label', { referrers: [...firstReferrers, { referrer: '', count: 4, uniques: 2 }] },
      /referrers entry 2 must carry a non-empty referrer/],
    ['a negative uniques value', { referrers: [...firstReferrers, { referrer: 'example.org', count: 1, uniques: -1 }] },
      /referrers entry 2 must carry a non-negative integer uniques/],
  ]);
  for (const [label, payload, message] of cases) {
    const db = await fixture(t);
    // Both referrers and the first popular path are appended before the failure lands.
    const { trafficClient } = fakeListClient({
      referrers: firstReferrers,
      popularPaths: firstPaths,
      ...payload,
    });
    await assert.rejects(
      collectSnapshots({ db, repositoryId: 1, repo, runId: 'run-1', trafficClient, collectedAt: first }),
      message,
      `${label} must abort the repository capture`,
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM snapshots').get()?.n, 0,
      `${label} must leave no half-written capture`);

    const { trafficClient: retry } = fakeListClient({ referrers: firstReferrers, popularPaths: firstPaths });
    const captured = await collectSnapshots({
      db, repositoryId: 1, repo, runId: 'run-1', trafficClient: retry, collectedAt: second,
    });
    assert.deepEqual(captured, { referrers: 2, popularPaths: 2, rows: 4 }, `${label} retried`);
    const history = readSnapshotHistory(db, 1, POPULAR_PATHS_KIND);
    assert.equal(history.length, 2, `${label} must not merge the aborted and the retried capture`);
    assert.ok(history.every((row) => row.collectedAt === second));
  }
});

test('the append is composable with the day series inside one transaction', async (t) => {
  const db = await fixture(t);
  assert.throws(() => withTransaction(db, () => {
    writeSnapshotCaptures({ db, repositoryId: 1, runId: 'run-1', referrers: firstReferrers,
      popularPaths: firstPaths, collectedAt: first });
    appendSnapshot(db, { repositoryId: 1, runId: 'run-does-not-exist', kind: REFERRERS_KIND,
      label: 'example.org', count: 1, uniques: 1, position: 0, collectedAt: first });
  }), /FOREIGN KEY constraint/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM snapshots').get()?.n, 0);
});

test('an unknown repository, a bad capture time and an unusable run are refused before any request', async (t) => {
  const db = await fixture(t);
  const { calls, trafficClient } = fakeListClient({ referrers: firstReferrers, popularPaths: firstPaths });
  await assert.rejects(
    collectSnapshots({ db, repositoryId: 999, repo, runId: 'run-1', trafficClient, collectedAt: first }),
    /Unknown repository 999/,
  );
  for (const collectedAt of ['2026-10-01T00:00:00Z', '2026-10-01T01:00:00.000+01:00', 'not a timestamp']) {
    await assert.rejects(
      collectSnapshots({ db, repositoryId: 1, repo, runId: 'run-1', trafficClient, collectedAt }),
      /Invalid collection timestamp/,
    );
  }
  for (const runId of /** @type {unknown[]} */ (['', undefined, 42])) {
    await assert.rejects(
      collectSnapshots({ db, repositoryId: 1, repo, runId: /** @type {string} */ (runId),
        trafficClient, collectedAt: first }),
      /run identifier/,
      `run identifier ${String(runId)} must be refused`,
    );
  }
  assert.deepEqual(calls, []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM snapshots').get()?.n, 0);
});