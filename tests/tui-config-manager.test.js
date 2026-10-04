/**
 * The configuration manager, driven the way a returning maintainer drives it.
 *
 * Every test writes its answers to a stream the test owns and reads back everything the
 * manager wrote, so no test needs a terminal and no test can pass on a transcript nobody
 * read. The home is temporary and already holds a configuration, because the manager
 * changes a configuration that exists; the GitHub stub is the loopback server behind
 * `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT`, so the only request the visit can make is the one
 * the discovery command makes.
 *
 * The assertions that matter are the ones a transcript cannot hide: that a saved enrolment
 * parses through the existing loader rather than through anything the manager wrote itself,
 * that a repository turned off stays in the enrolled set with its flag false and the
 * product's own enrolment resolver stops collecting it, that a repository the deny list
 * names cannot be enrolled in either spelling, that an interrupted edit leaves the previous
 * configuration byte-identical, and that the visit made no request the discovery command
 * did not already make.
 */

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { loadConfig, parseConfig } from '../src/config/load.js';
import { resolveEnrollment } from '../src/enrollment/resolve.js';
import { CONFIG_MANAGER_MENU, runConfigManager } from '../src/tui/config-manager.js';
import { createStubGitHub } from './helpers/stub-github-server.mjs';

const TOKEN = 'ghp_' + 'OBVIOUSLY_FAKE_CONFIG_MANAGER_TOKEN';
const ESCAPE = /\u001b/u;

const LISTING = [
  { full_name: 'owner/alpha', visibility: 'private', permissions: { admin: true } },
  { full_name: 'owner/beta', visibility: 'public', permissions: { admin: true } },
  { full_name: 'owner/gamma', visibility: 'public', permissions: { admin: false } },
];

/** Menu rows the manager prints, counted from one. */
const ADD = '1';
const REMOVE = '2';
const FLAG = '3';
const DENY = '4';
const HOUR = '5';
const REFRESH = '6';
const LEAVE = '7';

/**
 * The configuration most tests start from: one enrolled repository with no flag of its
 * own, no deny entries and the schema's default hour, so the saved document is the shape a
 * first run leaves and a returning visit has to be able to edit.
 * @returns {string}
 */
function startingConfiguration() {
  return `${JSON.stringify({ enrolled: ['owner/alpha'] }, null, 2)}\n`;
}

/**
 * A temporary home that already holds a configuration and a credential, a loopback GitHub
 * stub and a `drive` that runs the manager with scripted answers. The local-transport gate
 * is set on the real process environment because that is the gate the transport reads; it
 * is restored after.
 * @param {import('node:test').TestContext} t
 * @param {{ configuration?: string|null, listing?: unknown[] }} [existing] What the home holds and what the stub serves.
 * @returns {Promise<ManagerFixture>}
 */
async function fixture(t, existing = {}) {
  const previousGate = process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
  t.after(() => {
    if (previousGate === undefined) delete process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
    else process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = previousGate;
  });
  process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = '1';

  const directory = mkdtempSync('/tmp/opencode/repo-signal-config-manager-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const configPath = path.join(home, 'config.json');
  const credentialsPath = path.join(home, 'credentials.json');
  if (existing.configuration !== undefined && existing.configuration !== null) {
    writeFileSync(configPath, existing.configuration, { mode: 0o600 });
  }
  writeFileSync(credentialsPath, `${JSON.stringify({ token: TOKEN }, null, 2)}\n`, { mode: 0o600 });

  const stub = createStubGitHub({ token: TOKEN });
  t.after(() => stub.stop());
  stub.route('GET /user/repos*', { json: existing.listing ?? LISTING });
  const baseUrl = await stub.start();
  const env = {
    ...process.env,
    REPO_SIGNAL_HOME: home,
    REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT: '1',
    REPO_SIGNAL_GITHUB_BASE_URL: baseUrl,
  };

  /**
   * @param {string[]} answers One answer per line of every question the visit asks.
   * @param {{ env?: NodeJS.ProcessEnv, listRepositories?: () => Promise<import('../src/tui/config-manager.js').DiscoveredRepository[]>,
   *   saveConfiguration?: (request: { configPath: string, document: string }) => void } } [options]
   * @returns {Promise<{ outcome: import('../src/tui/config-manager.js').ConfigManagerOutcome, output: string }>}
   */
  const drive = async (answers, options = {}) => {
    /** @type {string[]} */
    const chunks = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const outcome = await runConfigManager({
      input: Readable.from([answers.map((answer) => `${answer}\n`).join('')]),
      output,
      env: options.env ?? env,
      cwd: directory,
      ...(options.listRepositories === undefined ? {} : { listRepositories: options.listRepositories }),
      ...(options.saveConfiguration === undefined ? {} : { saveConfiguration: options.saveConfiguration }),
    });
    return { outcome, output: chunks.join('') };
  };

  return { directory, home, configPath, credentialsPath, env, stub, drive };
}

/**
 * @typedef {object} ManagerFixture
 * @property {string} directory
 * @property {string} home
 * @property {string} configPath
 * @property {string} credentialsPath
 * @property {NodeJS.ProcessEnv} env
 * @property {import('./helpers/stub-github-server.mjs').StubGitHub} stub
 * @property {(answers: string[], options?: {
 *   env?: NodeJS.ProcessEnv,
 *   listRepositories?: () => Promise<import('../src/tui/config-manager.js').DiscoveredRepository[]>,
 *   saveConfiguration?: (request: { configPath: string, document: string }) => void,
 * }) => Promise<{ outcome: import('../src/tui/config-manager.js').ConfigManagerOutcome, output: string }>} drive
 */

/**
 * The configuration as the existing loader reads it, which is the only definition of
 * whether a saved file is usable.
 * @param {ManagerFixture} f
 * @returns {import('../src/config/schema.js').Configuration}
 */
function loaded(f) {
  return loadConfig({ env: f.env, cwd: f.directory });
}

/**
 * A discovery list seam serving these repositories, standing in for a payload the discovery
 * command filtered against a deny list that has since changed.
 * @param {string[]} names
 * @returns {() => Promise<import('../src/tui/config-manager.js').DiscoveredRepository[]>}
 */
function seamListing(names) {
  return () => Promise.resolve(names.map((name) => (
    { name, visibility: 'public', administrationRead: true }
  )));
}

/**
 * A seam that serves one list and then fails, so a refresh can be shown to keep what the
 * visit already held rather than losing it.
 * @param {string[]} names
 * @returns {() => Promise<import('../src/tui/config-manager.js').DiscoveredRepository[]>}
 */
function seamListingOnce(names) {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls > 1) throw new Error('the discovery payload carried no repository list');
    return seamListing(names)();
  };
}

test('the manager states the enrolled set with each flag, the deny list and the collection hour before the menu', async (t) => {
  const configuration = `${JSON.stringify({
    enrolled: ['owner/alpha', 'owner/beta'],
    denyList: ['owner/beta'],
    collectionHourUtc: 6,
    enabled: { 'owner/beta': false },
  }, null, 2)}\n`;
  const f = await fixture(t, { configuration });
  const { outcome, output } = await f.drive(['q']);

  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.exitCode, 1);
  // Each flag is a word, not a colour and not a symbol.
  assert.match(output, /^enrolled \(2\): owner\/alpha \(enabled\), owner\/beta \(disabled\)$/mu);
  assert.match(output, /^enrolled and denied \(1\): owner\/beta; the deny list takes precedence, so these are not collected$/mu);
  assert.match(output, /^deny list \(1\): owner\/beta$/mu);
  assert.match(output, /^collection hour: 6 UTC; this manager sets the hour only and installs no schedule, your operating system owns that$/mu);
  // The state comes before the menu that changes it, and the home is named once.
  assert.ok(output.indexOf('enrolled (2):') < output.indexOf('What would you like to change'));
  assert.match(output, /^configuration: .*config\.json$/mu);
  assert.doesNotMatch(output, ESCAPE);
});

test('adding and removing an enrollment leaves a file the existing loader reads', async (t) => {
  const f = await fixture(t, { configuration: startingConfiguration() });
  // Add owner/beta from the discovery list, remove owner/alpha again, then leave the menu
  // with the item that ends the visit deliberately rather than with a cancellation.
  const { outcome, output } = await f.drive([ADD, '1 ', '', REMOVE, '1 ', '', LEAVE]);

  assert.deepEqual(outcome, {
    status: 'completed',
    exitCode: 0,
    message: 'the configuration manager returned to the previous menu',
    enrolled: ['owner/beta'],
  });
  assert.equal(stubListingCount(f), 1, 'the visit listed the repositories once, for the addition');
  // Both edits reached disk and both were read back through the loader that owns the file.
  assert.match(output, /configuration: saved at .*config\.json \(mode 0600\): added 1 repository to the enrolled set: owner\/beta/u);
  assert.match(output, /configuration: saved at .*config\.json \(mode 0600\): removed 1 repository from the enrolled set: owner\/alpha/u);
  assert.match(output, /the existing loader read it back with 1 enrolled repository \(owner\/beta\)/u);
  assert.match(output, /^configuration manager: left the menu; 2 edits saved$/mu);

  // The saved document parses through the existing loader, not through the manager's own shape.
  const document = readFileSync(f.configPath, 'utf8');
  assert.deepEqual(parseConfig(document).enrolled, ['owner/beta']);
  const configuration = loaded(f);
  assert.deepEqual(configuration.enrolled, ['owner/beta']);
  assert.deepEqual(configuration.enabled, { 'owner/beta': true }, 'the flag of the removed repository is not left behind');
  assert.equal(statSync(f.configPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(f.home).sort(), ['config.json', 'credentials.json'], 'no temporary file was left behind');
});

test('a repository whose flag was left behind by a hand-edited file is watched again', async (t) => {
  // A file edited by hand can carry a flag for a repository that is not enrolled. Enrolling
  // that repository is a new request to watch it, so the saved flag is true rather than the
  // stale false: the file is a rendering of the enrolled set, not a log of edits.
  const f = await fixture(t, {
    configuration: `${JSON.stringify({
      enrolled: ['owner/alpha'], enabled: { 'owner/beta': false },
    }, null, 2)}\n`,
  });
  const { outcome, output } = await f.drive([ADD, '1 ', '', LEAVE]);

  assert.equal(outcome.status, 'completed');
  assert.match(output, /configuration: saved at .*added 1 repository to the enrolled set: owner\/beta$/mu);
  const configuration = loaded(f);
  assert.deepEqual(configuration.enrolled, ['owner/alpha', 'owner/beta']);
  assert.deepEqual(configuration.enabled, { 'owner/alpha': true, 'owner/beta': true });
  // The product's own enrolment resolver is what says whether the repository is collected.
  assert.deepEqual(resolveEnrollment(configuration), ['owner/alpha', 'owner/beta']);
});

test('turning a repository off keeps it enrolled with its flag false', async (t) => {
  const f = await fixture(t, { configuration: startingConfiguration() });
  const { outcome, output } = await f.drive([FLAG, '1', HOUR, '', LEAVE]);

  assert.equal(outcome.status, 'completed');
  assert.match(output, /configuration: saved at .*config\.json \(mode 0600\): owner\/alpha is now disabled and stays in the enrolled set, so it is no longer collected/u);

  const configuration = loaded(f);
  assert.deepEqual(configuration.enrolled, ['owner/alpha'], 'the enrolment is unchanged: disabling is not removing');
  assert.equal(configuration.enabled['owner/alpha'], false, 'the flag is false');
  // The product's own enrolment resolver is what gives the flag its meaning, so it is what
  // says whether the repository is still collected.
  assert.deepEqual(resolveEnrollment(configuration), []);
  assert.equal(resolveEnrollment({ ...configuration, enabled: { 'owner/alpha': true } })[0], 'owner/alpha');
  // Turning it back on is the same menu item and restores the flag without re-enrolling.
  assert.equal(f.stub.paths().length, 0, 'changing a flag made no request');
});

test('turning a repository back on restores its flag without changing the enrolled set', async (t) => {
  const configuration = `${JSON.stringify({
    enrolled: ['owner/alpha'], enabled: { 'owner/alpha': false },
  }, null, 2)}\n`;
  const f = await fixture(t, { configuration });
  const { outcome, output } = await f.drive([FLAG, '1', LEAVE]);

  assert.equal(outcome.status, 'completed');
  assert.match(output, /owner\/alpha is now enabled and stays in the enrolled set/u);
  assert.deepEqual(loaded(f).enabled, { 'owner/alpha': true });
  assert.deepEqual(resolveEnrollment(loaded(f)), ['owner/alpha']);
});

test('a repository the deny list names cannot be enrolled, in either spelling', async (t) => {
  // The deny entry and the reachable repository are the same repository spelled differently,
  // which is the comparison the loader, the enrolment resolver and the discovery command all
  // make case-insensitively. Both directions refuse, and neither saves anything.
  const cases = [
    { deny: 'owner/Gamma', reachable: 'owner/gamma' },
    { deny: 'owner/gamma', reachable: 'Owner/Gamma' },
  ];
  for (const { deny, reachable } of cases) {
    const f = await fixture(t, {
      configuration: `${JSON.stringify({ enrolled: ['owner/alpha'], denyList: [deny] }, null, 2)}\n`,
    });
    const before = readFileSync(f.configPath, 'utf8');
    const { outcome, output } = await f.drive([ADD, 'q', LEAVE], {
      listRepositories: seamListing(['owner/alpha', reachable, 'owner/beta']),
    });

    assert.equal(outcome.status, 'completed', `the visit completed for the deny entry ${deny}`);
    // The row is absent, and the line that explains its absence names the deny entry itself.
    assert.doesNotMatch(
      output,
      new RegExp(`^\\s+\\d+\\) ${reachable}`, 'mu'),
      `a denied repository is never offered as a row for the deny entry ${deny}`,
    );
    assert.match(
      output,
      new RegExp(`^denied: ${reachable} is named by the deny entry ${deny}; remove that entry before enrolling it$`, 'mu'),
      `the refusal names the deny entry for the deny entry ${deny}`,
    );
    // The repository that is not denied is still offered, so the refusal is about this
    // repository rather than about the visit having nothing to add at all.
    assert.match(output, /^\s+1\) owner\/beta - not selected$/mu);
    assert.equal(readFileSync(f.configPath, 'utf8'), before, `a refusal saved nothing for the deny entry ${deny}`);
    assert.deepEqual(loaded(f).enrolled, ['owner/alpha']);
  }
});

test('the addition step refuses a denied repository and saves nothing when nothing else is offerable', async (t) => {
  // Two repositories are already enrolled and the third is denied, so the discovery command's
  // own filtering leaves the manager with nothing to offer at all. This runs the real
  // discovery path rather than a seam.
  const f = await fixture(t, {
    configuration: `${JSON.stringify({
      enrolled: ['owner/alpha', 'owner/beta'], denyList: ['owner/gamma'],
    }, null, 2)}\n`,
  });
  const before = readFileSync(f.configPath, 'utf8');
  const { outcome, output } = await f.drive([ADD, LEAVE]);

  assert.equal(outcome.status, 'completed');
  assert.match(output, /already enrolled \(2\): owner\/alpha, owner\/beta$/mu);
  assert.match(output, /^add: nothing to offer; every reachable repository is already enrolled or on the deny list, and nothing was saved$/mu);
  assert.equal(readFileSync(f.configPath, 'utf8'), before);
  assert.doesNotMatch(output, /configuration: saved at/u, 'a refusal saves nothing');
});

test('an interrupted edit leaves the previous configuration byte-identical', async (t) => {
  const f = await fixture(t, { configuration: startingConfiguration() });
  // One edit is saved, so there is a previous version that an interruption must preserve.
  const saved = await f.drive([HOUR, '6', LEAVE]);
  assert.equal(saved.outcome.status, 'completed');
  const afterSavedEdit = readFileSync(f.configPath, 'utf8');
  assert.equal(loaded(f).collectionHourUtc, 6);

  const cancelled = await f.drive([ADD, 'q', REMOVE, 'q', FLAG, 'q', DENY, 'q', HOUR, 'q']);
  assert.equal(cancelled.outcome.status, 'cancelled');
  assert.equal(cancelled.outcome.exitCode, 1);
  assert.match(cancelled.output, /cancelled: the selection was left as it was, because q cancels/u);
  assert.match(cancelled.output, /^collection hour: no value was entered, because q cancels\.; the configured hour is unchanged$/mu);
  assert.match(cancelled.output, /^configuration manager stopped: standard input ended before a choice was made\.; no edit was saved; the cancelled step changed nothing$/mu);
  assert.equal(readFileSync(f.configPath, 'utf8'), afterSavedEdit, 'a cancelled step wrote nothing');

  // An interruption that arrives as the end of standard input is the same case: the edit
  // was never completed, so nothing was written.
  const ended = await f.drive([FLAG]);
  assert.equal(ended.outcome.status, 'cancelled');
  assert.match(ended.outcome.message ?? '', /standard input ended before a choice was made/u);
  assert.match(ended.output, /^flag: standard input ended before a choice was made\.; no flag changed$/mu);
  assert.equal(readFileSync(f.configPath, 'utf8'), afterSavedEdit, 'an ended input wrote nothing');
  assert.deepEqual(readdirSync(f.home).sort(), ['config.json', 'credentials.json'], 'no temporary file was left behind');

  // An edit that completed before the interruption stays saved, and the visit says how many
  // edits it saved rather than reporting the whole visit as though nothing happened.
  const completedThenEnded = await f.drive([FLAG, '1']);
  assert.equal(completedThenEnded.outcome.status, 'cancelled');
  assert.match(completedThenEnded.output, /owner\/alpha is now disabled and stays in the enrolled set/u);
  assert.match(completedThenEnded.output, /^configuration manager stopped: .*; 1 edit saved; the cancelled step changed nothing$/mu);
  const afterFlagEdit = readFileSync(f.configPath, 'utf8');
  assert.equal(loaded(f).enabled['owner/alpha'], false);

  // A write that fails the way a full disk does leaves the file exactly as it was, and the
  // visit says so rather than continuing as though the edit had been saved.
  const failed = await f.drive([HOUR, '9', HOUR, '9', LEAVE], {
    saveConfiguration: ({ configPath: requestPath, document }) => {
      assert.equal(requestPath, f.configPath);
      assert.match(document, /"collectionHourUtc": 9/u, 'only a document the loader accepted is offered to the writer');
      throw new Error('the disk refused the write');
    },
  });
  assert.equal(failed.outcome.status, 'failed');
  assert.equal(failed.outcome.exitCode, 1);
  assert.match(failed.output, /configuration: not saved: the disk refused the write; .*config\.json is unchanged/u);
  assert.match(failed.outcome.message, /2 edits could not be saved/u);
  assert.equal(readFileSync(f.configPath, 'utf8'), afterFlagEdit, 'a failed write left the previous file byte-identical');
  assert.equal(loaded(f).collectionHourUtc, 6, 'the failed edit is not in the configuration the loader reads');
  assert.deepEqual(readdirSync(f.home).sort(), ['config.json', 'credentials.json']);
});

test('a repository that is also denied is not offered for removal, with the deny list shown', async (t) => {
  const configuration = `${JSON.stringify({
    enrolled: ['owner/alpha', 'owner/gamma'], denyList: ['owner/gamma'],
  }, null, 2)}\n`;
  const f = await fixture(t, { configuration });
  const { outcome, output } = await f.drive([REMOVE, '1 ', '', LEAVE]);

  assert.equal(outcome.status, 'completed');
  // The deny list is part of the edit, so the missing row has a stated reason.
  assert.match(output, /^deny list as it stands \(1\): owner\/gamma$/mu);
  assert.match(output, /^enrolled set as it stands \(2\): owner\/alpha \(enabled\), owner\/gamma \(enabled\)$/mu);
  assert.match(output, /^not removable here: owner\/gamma is named by the deny entry owner\/gamma; it is not collected because of that entry, so removing the enrolment would change nothing\. Remove the deny entry first and it becomes removable\.$/mu);
  assert.match(output, /^\s+1\) owner\/alpha - not selected$/mu);
  assert.doesNotMatch(output, /^\s+\d+\) owner\/gamma/mu);
  assert.match(output, /^accepted 1 of 1: owner\/alpha\.$/mu);
  assert.deepEqual(loaded(f).enrolled, ['owner/gamma'], 'the denied enrolment is still there, and still denied');
  assert.deepEqual(loaded(f).denyList, ['owner/gamma']);
  assert.deepEqual(resolveEnrollment(loaded(f)), []);
});

test('every enrolled repository being denied leaves nothing removable and nothing saved', async (t) => {
  const configuration = `${JSON.stringify({
    enrolled: ['owner/gamma'], denyList: ['owner/gamma'],
  }, null, 2)}\n`;
  const f = await fixture(t, { configuration });
  const { outcome, output } = await f.drive([REMOVE, LEAVE]);

  assert.equal(outcome.status, 'completed');
  assert.match(output, /^remove: nothing is removable; every enrolled repository is on the deny list, and nothing was saved$/mu);
  assert.doesNotMatch(output, /configuration: saved at/u);
});

test('the deny list gains and loses entries through the same save an enrollment uses', async (t) => {
  const f = await fixture(t, { configuration: startingConfiguration() });
  const added = await f.drive([DENY, '1', '1', LEAVE]);

  assert.equal(added.outcome.status, 'completed');
  assert.match(added.output, /configuration: saved at .*config\.json \(mode 0600\): the deny list now names owner\/alpha$/mu);
  assert.match(added.output, /^deny list: owner\/alpha is still enrolled and is no longer collected, because the deny list takes precedence over enrolment$/mu);
  assert.deepEqual(loaded(f).denyList, ['owner/alpha']);
  // Denying does not remove the enrolment, and the product's resolver stops collecting it.
  assert.deepEqual(loaded(f).enrolled, ['owner/alpha']);
  assert.deepEqual(resolveEnrollment(loaded(f)), []);
  assert.equal(added.outcome.enrolled[0], 'owner/alpha');

  const removed = await f.drive([DENY, '2', '1', LEAVE]);
  assert.equal(removed.outcome.status, 'completed');
  assert.match(removed.output, /^\s+1\) owner\/alpha - enrolled, so removing this entry makes it collectable again$/mu);
  assert.match(removed.output, /configuration: saved at .*config\.json \(mode 0600\): the deny list no longer names owner\/alpha$/mu);
  assert.deepEqual(loaded(f).denyList, []);
  assert.deepEqual(resolveEnrollment(loaded(f)), ['owner/alpha']);
  assert.equal(removed.outcome.status, 'completed');
});

test('the deny list accepts a repository discovery reached that is not enrolled', async (t) => {
  const f = await fixture(t, { configuration: startingConfiguration() });
  // The candidates are the enrolled set first, then what discovery reached, and discovery
  // is fetched once because the add step asked for it.
  const { outcome, output } = await f.drive([ADD, 'q', DENY, '1', '2', LEAVE]);

  assert.equal(outcome.status, 'completed');
  assert.match(output, /^\s+2\) owner\/beta$/mu, 'a reachable repository that is not enrolled can be denied');
  assert.match(output, /configuration: saved at .*config\.json \(mode 0600\): the deny list now names owner\/beta$/mu);
  assert.deepEqual(loaded(f).denyList, ['owner/beta']);
  assert.doesNotMatch(output, /is still enrolled/u, 'a repository that is not enrolled is not described as enrolled');
  assert.equal(stubListingCount(f), 1, 'the discovery command was run once and only once');
});

test('the visit continues from what the loader reads back, not from the edit it assembled', async (t) => {
  // A write that lands something else is the only way to tell a read-back from a value the
  // manager already had in memory: the loader owns what the visit believes it saved, so the
  // flag it reports and the state it prints afterwards are the loader's answers.
  const f = await fixture(t, { configuration: startingConfiguration() });
  const { outcome, output } = await f.drive([FLAG, '1', LEAVE], {
    saveConfiguration: ({ configPath, document }) => {
      assert.match(document, /"owner\/alpha": false/u, 'only a document the loader accepted is offered to the writer');
      writeFileSync(configPath, `${JSON.stringify({ enrolled: ['owner/beta'] }, null, 2)}\n`, { mode: 0o600 });
    },
  });

  assert.equal(outcome.status, 'completed');
  assert.match(output, /configuration: the existing loader read it back with 1 enrolled repository \(owner\/beta\), 0 deny entries, collection hour 0 UTC$/mu);
  assert.deepEqual(outcome.enrolled, ['owner/beta'], 'the visit continues from the file the loader read');
  assert.match(output, /^enrolled \(1\): owner\/beta \(enabled\)$/mu, 'the state after the edit is the loader state');
  assert.deepEqual(loaded(f).enrolled, ['owner/beta']);
});

test('a configuration the visit cannot write is left byte-identical, with no temporary file', async (t) => {
  // A home directory the current user cannot write is the write failure that needs no seam:
  // the temporary file cannot be created, so the previous configuration is never opened for
  // writing at all. A privileged process ignores the directory mode, so the refusal this test
  // provokes cannot happen for one, and the test says so rather than passing vacuously.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('a privileged process ignores the home directory mode');
    return;
  }
  const f = await fixture(t, { configuration: startingConfiguration() });
  const before = readFileSync(f.configPath, 'utf8');
  try {
    chmodSync(f.home, 0o500);
    const { outcome, output } = await f.drive([HOUR, '6', LEAVE]);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.exitCode, 1);
    assert.match(output, /configuration: not saved: .*config\.json could not be written \(EACCES\).*nothing was written, and whatever was there before is unchanged/u);
    assert.equal(readFileSync(f.configPath, 'utf8'), before, 'the previous configuration is byte-identical');
    assert.equal(loaded(f).collectionHourUtc, 0, 'the edit is not in the configuration the loader reads');
    assert.deepEqual(readdirSync(f.home).sort(), ['config.json', 'credentials.json'], 'no temporary file was left behind');
  } finally {
    // The home has to be writable again before the fixture removes it.
    chmodSync(f.home, 0o700);
  }
});

test('the collection hour is refused with the schema its own words and then saved', async (t) => {
  const f = await fixture(t, { configuration: startingConfiguration() });
  const before = readFileSync(f.configPath, 'utf8');
  // The hour the schema refuses is asked again rather than coerced, and the cancellation ends
  // the visit with the configuration exactly as it was.
  const refused = await f.drive([HOUR, '24', 'q']);

  assert.equal(refused.outcome.status, 'cancelled');
  // The range belongs to the schema every command reads through, not to the prompt.
  assert.match(refused.output, /refused: Configuration key collectionHourUtc: expected an integer UTC hour from 0 through 23/u);
  assert.match(refused.output, /type a whole hour from 0 through 23, or press Enter for 0/u);
  assert.equal(readFileSync(f.configPath, 'utf8'), before, 'a refused hour saves nothing');

  const accepted = await f.drive([HOUR, '7', LEAVE]);
  assert.equal(accepted.outcome.status, 'completed');
  assert.match(accepted.output, /configuration: saved at .*config\.json \(mode 0600\): the collection hour is 7 UTC$/mu);
  assert.equal(loaded(f).collectionHourUtc, 7);
});

test('an empty answer to the collection hour keeps the hour the configuration holds', async (t) => {
  const configuration = `${JSON.stringify({ enrolled: ['owner/alpha'], collectionHourUtc: 6 }, null, 2)}\n`;
  const f = await fixture(t, { configuration });
  const { outcome, output } = await f.drive([HOUR, '', LEAVE]);

  assert.equal(outcome.status, 'completed');
  assert.match(output, /An empty answer keeps 6/u);
  assert.equal(loaded(f).collectionHourUtc, 6, 'the hour it already held is the hour it keeps');
});

test('refreshing the discovery list runs the discovery command again and reports it', async (t) => {
  const f = await fixture(t, { configuration: startingConfiguration() });
  const { outcome, output } = await f.drive([ADD, 'q', REFRESH, LEAVE]);

  assert.equal(outcome.status, 'completed');
  assert.equal(stubListingCount(f), 2, 'the add step and the refresh each ran the discovery command once');
  assert.match(output, /^discovery: refreshed; 3 repositories reachable$/mu);
  assert.match(output, /^owner\/gamma visibility=public enrolled=no administration-read=no$/mu);
  assert.doesNotMatch(output, /configuration: saved at/u, 'a refresh saves nothing');
});

test('a failed refresh keeps the list the visit already held', async (t) => {
  const f = await fixture(t, { configuration: startingConfiguration() });
  // The first fetch succeeds and the refresh fails, so the deny list step is offered the
  // repository the visit read before the failure: a failed list never empties what is held.
  const { outcome, output } = await f.drive([ADD, 'q', REFRESH, DENY, '1', '2', LEAVE], {
    listRepositories: seamListingOnce(['owner/beta', 'owner/gamma']),
  });

  assert.equal(outcome.status, 'completed');
  assert.match(output, /^discovery: the discovery payload carried no repository list$/mu);
  assert.match(output, /^discovery: the refresh failed, so the list this visit already held is unchanged and nothing was saved$/mu);
  assert.match(output, /^\s+2\) owner\/beta$/mu, 'the repository the first fetch reached is still a candidate');
  assert.match(output, /configuration: saved at .*config\.json \(mode 0600\): the deny list now names owner\/beta$/mu);
  assert.deepEqual(loaded(f).denyList, ['owner/beta']);
});

test('colour disabled and a dumb terminal change nothing the operator reads', async (t) => {
  const f = await fixture(t, { configuration: startingConfiguration() });
  const { outcome, output } = await f.drive([FLAG, '1', ADD, '1 ', '', LEAVE], {
    env: { ...f.env, NO_COLOR: '1', TERM: 'dumb' },
  });

  assert.equal(outcome.status, 'completed');
  assert.doesNotMatch(output, ESCAPE, 'no escape sequence is written when colour is disabled or the terminal is dumb');
  // Every state the manager reports is a word, and the selection is readable without colour.
  assert.match(output, /^\s+1\) owner\/beta - not selected$/mu);
  assert.match(output, /^row 1 \(owner\/beta\) is now selected\.$/mu);
  assert.match(output, /^enrolled \(2\): owner\/alpha \(disabled\), owner\/beta \(enabled\)$/mu);
});

test('the manager refuses a home with no configuration and writes nothing', async (t) => {
  const f = await fixture(t, { configuration: null });
  const { outcome, output } = await f.drive([ADD]);

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.exitCode, 1);
  assert.match(output, /there is no configuration at .*config\.json, so this manager has nothing to change and wrote nothing/u);
  assert.doesNotMatch(output, /What would you like to change/u, 'no menu was offered');
  assert.equal(existsSync(f.configPath), false, 'nothing was written');
});

test('a configuration the existing loader refuses is reported in the loader own words', async (t) => {
  const f = await fixture(t, {
    configuration: `${JSON.stringify({ enrolled: ['owner/alpha'], unexpected: true }, null, 2)}\n`,
  });
  const { outcome, output } = await f.drive([LEAVE]);

  assert.equal(outcome.status, 'failed');
  assert.match(output, /the existing loader refused the configuration at .*Configuration key unexpected: unknown key/u);
  assert.match(output, /nothing was written/u);
});

test('a cancelled step returns to the menu with nothing changed', async (t) => {
  const f = await fixture(t, { configuration: startingConfiguration() });
  // `q` cancels the step and returns to the previous one, so the visit continues rather than
  // ending, and the cancelled step left the configuration alone.
  const { outcome, output } = await f.drive([REMOVE, 'q', DENY, 'q', HOUR, '6', LEAVE]);

  assert.equal(outcome.status, 'completed');
  assert.match(output, /configuration: saved at .*config\.json \(mode 0600\): the collection hour is 6 UTC$/mu);
  assert.match(output, /^deny list: no choice was made, because q cancels\.; the deny list is unchanged$/mu);
  assert.match(output, /^remove: the selection was left as it was, because q cancels\.; the enrolled set is unchanged$/mu);
  assert.equal(loaded(f).collectionHourUtc, 6);
  assert.deepEqual(loaded(f).enrolled, ['owner/alpha'], 'no enrolment was removed');
  assert.deepEqual(loaded(f).denyList, [], 'no deny entry was added');
});

test('the module names the menu the command help will print', () => {
  assert.equal(CONFIG_MANAGER_MENU.length, 7, 'seven actions, so the dispatch covers what the menu offers');
  assert.deepEqual(
    CONFIG_MANAGER_MENU.filter((label) => label.trim() === ''),
    [],
    'no menu item is blank',
  );
  assert.equal(new Set(CONFIG_MANAGER_MENU).size, CONFIG_MANAGER_MENU.length, 'no menu item is stated twice');
  assert.match(CONFIG_MANAGER_MENU[2] ?? '', /without removing it/u, 'the toggle states that disabling is not removing');
  assert.match(CONFIG_MANAGER_MENU.at(-1) ?? '', /Return to the previous menu/u);
  // The exported list is frozen, so a caller cannot reorder the menu the dispatch indexes.
  assert.equal(Object.isFrozen(CONFIG_MANAGER_MENU), true);
});

/**
 * How many times the stub served the repository listing, which is the only request this
 * visit can make and the only one the discovery command makes on its behalf.
 * @param {ManagerFixture} f
 * @returns {number}
 */
function stubListingCount(f) {
  return f.stub.paths().filter((entry) => entry.startsWith('/user/repos')).length;
}