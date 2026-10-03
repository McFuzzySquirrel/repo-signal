import { TRAFFIC_PERMISSION } from '../../supervision/errors.js';
import {
  REPOSITORY_STATE_PRECEDENCE, collectionHealth, statePhrase,
} from '../../supervision/health.js';
import { documentShell, escapeAttribute, escapeText } from '../html.js';
import { labelledSection, namedLink } from './a11y.js';

/**
 * The collection health page: whether collection is working, one row per enrolled
 * repository, in the words the health read used.
 *
 * This page answers one question - "is collection working right now?" - and it
 * answers it from `src/supervision/health.js`, the one read the CLI shares. Nothing
 * here decides a state, re-derives a schedule, or re-words the read's reasoning: the
 * state word, the sentence beneath it and the roll-up sentence are mounted exactly as
 * they were returned, so a maintainer looking at this page and a maintainer looking at
 * `collect`'s output are looking at the same words for the same repository.
 *
 * Five rules decide what the page is allowed to say, and each is asserted by a test
 * rather than trusted to review.
 *
 * 1. **A state is a word and a sentence, both in text.** Every row carries the state
 *    word the read returned and the sentence that read wrote for it, so a page with
 *    every class attribute removed still says what state each repository is in. No
 *    colour, badge or icon carries any of it (RS-AX-07).
 * 2. **An action cell names what to do, from recorded evidence only.** A repository
 *    that needs a new token gets a link to the re-authentication guidance on this
 *    page, naming the permission the traffic endpoints require; a stalled repository
 *    gets the warning naming the last successful collection, because that instant is
 *    the evidence for the warning. A state with no recorded failure behind it gets no
 *    invented remedy, and a never-collected repository gets first-connect wording and
 *    no failure action at all: it has not run, which is not a failure.
 * 3. **A failure is never restated as a data gap.** A refused token stopped the
 *    collection; it did not turn a stored day into a missing one, so no sentence here
 *    pairs failure wording with gap wording. The reverse is stated too: the days a run
 *    never reached are days with no stored row, not failures, and no day the archive
 *    does not hold is counted here as a failed collection.
 * 4. **Only recorded values are shown.** A last success, a failure streak, a failure
 *    kind, a recorded instant and a lifecycle word come from the archive. Nothing is
 *    inferred from what is missing, and a repository with no recorded success is shown
 *    as not yet connected rather than as stalled or broken (RS-HO-01, RS-DU-02).
 * 5. **The page is a local document.** No script, no inline handler, no remote font,
 *    image or stylesheet, no animation, and no colour literal: the stylesheet is the
 *    one `src/ui/theme.css` route serves, and every state here is legible with that
 *    stylesheet removed.
 *
 * Every render function is pure: no clock, no I/O, no randomness, and identical input
 * produces identical bytes. Every dynamic value passes the shared helper for its own
 * context, so an identity whose stored spelling is markup reaches the page as text.
 */

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../../supervision/health.js').CollectionHealth} CollectionHealth */
/** @typedef {import('../../supervision/health.js').HealthSummary} HealthSummary */
/** @typedef {import('../../supervision/health.js').RunHealth} RunHealth */
/** @typedef {import('../../supervision/health.js').RepositoryHealth} RepositoryHealth */
/** @typedef {import('../../supervision/health.js').RepositoryState} RepositoryState */

/**
 * The context this page is rendered with. The router builds a context for the three
 * routes it dispatches; a page mounted at a path the router does not name is handed
 * this one, which carries no window because this page reads recorded collection state
 * rather than a range of days.
 *
 * @typedef {object} HealthPageContext
 * @property {'health'} route
 * @property {string|null} owner Always null: this page names every enrolled repository.
 * @property {string|null} name Always null, for the same reason.
 * @property {string|null} from Always null: no day range is read or shown here.
 * @property {string|null} to Always null, for the same reason.
 * @property {{ index: string, list: string, detail: (owner: string, name: string) => string }} links
 *   Generated links. `detail` addresses a repository's own page; it carries no range,
 *   so that page resolves and states the window it read.
 */

/** The page title suffix every page carries, so a browser tab and a history entry name the product. */
export const TITLE_SUFFIX = 'RepoSignal';

/**
 * Where this page is served from. The path belongs to the page module and the registry
 * mounts it here, so adding this page was a change in the registry plus this file and
 * nowhere else.
 */
export const HEALTH_PAGE_PATH = '/health';

/**
 * The sections of the page, in the order they appear. Exported as data so
 * `tests/views/health-view.test.js` can assert the rendered heading sequence against
 * the structure rather than against a remembered template.
 * @type {readonly string[]}
 */
export const HEALTH_SECTION_ORDER = Object.freeze(['whole-archive', 'repositories', 're-authentication']);

/** The heading each section carries, keyed by the section key above. */
const SECTION_HEADINGS = Object.freeze({
  'whole-archive': 'Collection state of this archive',
  repositories: 'Enrolled repositories',
  're-authentication': 'Re-authenticating with the traffic permission',
});

/** The identifier the re-authentication section carries, so a row's action can link to it. */
export const REAUTHENTICATE_ANCHOR = 'reauthenticate';

/** What the last-success cell says for a repository no run has ever collected. */
export const NO_SUCCESS_TEXT = 'no successful collection has been recorded';

/** What the failure cell says for a repository nothing has failed against. */
export const NO_FAILURE_TEXT = 'No failure has been recorded against this repository.';

/** What a never-collected row says it is, in words rather than as a fault. */
export const NOT_YET_CONNECTED_TEXT = 'Not yet connected';

/**
 * The fields the roll-up keeps behind each state word, keyed by the word itself. The
 * order is the read's own precedence, so the breakdown on the page cannot invent an
 * order of its own and cannot leave a state out.
 * @typedef {'healthy'|'neverCollected'|'degraded'|'needsReauthentication'|'stalled'
 *   |'unavailable'|'unreadable'} SummaryCountField
 */

/** @type {Readonly<Record<RepositoryState, SummaryCountField>>} */
const SUMMARY_COUNT_FIELD = Object.freeze({
  unavailable: 'unavailable',
  'needs-re-authentication': 'needsReauthentication',
  unreadable: 'unreadable',
  stalled: 'stalled',
  degraded: 'degraded',
  'never-collected': 'neverCollected',
  healthy: 'healthy',
});

/**
 * What this page shows, read once: the recorded state of every enrolled repository,
 * the roll-up across the set, and the most recent run. Each part is the health read's
 * own value, unchanged.
 *
 * @typedef {object} CollectionHealthData
 * @property {string} readAt The instant this read was taken, from the injected clock.
 * @property {HealthSummary} summary The enrolled-set roll-up, as the read returned it.
 * @property {RunHealth} run The most recent recorded run, as the read returned it.
 * @property {RepositoryHealth[]} repositories Enrolled repositories, in the archive's own order.
 */

/**
 * Read the collection health this page shows.
 *
 * The read is the one the CLI shares, called with the clock the caller injected, so
 * two rows can never disagree about how long ago a collection succeeded and rendering
 * the same archive twice produces the same page. No range is read and no window is
 * shown: this page reports recorded collection state, which has no day dimension, so
 * there is nothing here for a range to select and nothing a reader could mistake for
 * a measurement of a window.
 *
 * @param {object} options
 * @param {Database} options.db Open archive; the caller owns closing it.
 * @param {() => number} options.clock Epoch milliseconds the health read is judged against.
 * @returns {CollectionHealthData}
 */
export function readCollectionHealthPage({ db, clock }) {
  const health = collectionHealth({ db, clock });
  return {
    readAt: health.readAt,
    summary: health.summary,
    run: health.run,
    repositories: health.repositories,
  };
}

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} many
 * @returns {string} `1 <singular>` or `<n> <many>`.
 */
function counted(count, singular, many) {
  return `${count} ${count === 1 ? singular : many}`;
}

/**
 * One labelled section with its own heading, so the page can be navigated by heading
 * and so the heading sequence is structural rather than remembered.
 *
 * `anchor` names the section itself, so an action cell on the page can link to the
 * guidance a section carries. The link then resolves inside the document rather than
 * pointing at a host the loopback dashboard does not serve.
 *
 * The wrapper is `labelledSection` from `./a11y.js`, which emits the section element,
 * the generated heading identifier and the `aria-labelledby` pointing at it, so this
 * page cannot grow a landmark that announces itself as nothing.
 *
 * @param {string} key A member of {@link HEALTH_SECTION_ORDER}.
 * @param {string} body
 * @param {string} [anchor] Identifier for the section element itself.
 * @returns {string}
 */
function section(key, body, anchor) {
  const heading = SECTION_HEADINGS[/** @type {keyof typeof SECTION_HEADINGS} */ (key)];
  return labelledSection({
    key,
    heading,
    body,
    className: `health-section health-${key}`,
    ...(anchor === undefined ? {} : { anchor }),
  });
}

/**
 * Whether a recorded instant is one a machine can read. Every instant the archive
 * recorded is a canonical UTC ISO instant, but an unreadable value reaches the page
 * too - the `unreadable` state exists for exactly that - and such a value is shown as
 * the text the archive holds while carrying no `datetime` attribute an assistive
 * technology would try and fail to parse. Neither branch invents or repairs a value.
 *
 * @param {string} instant
 * @returns {boolean}
 */
function isMachineReadableInstant(instant) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(instant)
    && !Number.isNaN(Date.parse(instant));
}

/**
 * A recorded instant, in a `time` element carrying the machine-readable value beside
 * the text a reader reads. The instant is what the archive recorded; nothing here
 * recomputes it, rounds it or describes it as recent.
 *
 * @param {string} instant Canonical UTC ISO instant from the archive.
 * @returns {string}
 */
function recordedTime(instant) {
  if (!isMachineReadableInstant(instant)) {
    return `<span class="recorded-value" data-machine-readable="no">${escapeText(instant)}</span>`;
  }
  return `<time datetime="${escapeAttribute(instant)}">${escapeText(instant)}</time>`;
}

/**
 * The identity cell: the archive's own spelling of the repository, linked to that
 * repository's page. The reference is built by the context's own link helper and
 * attribute-escaped here, so an identity carrying markup or a slash cannot leave the
 * path segment it belongs in.
 *
 * @param {RepositoryHealth} health
 * @param {HealthPageContext} ctx
 * @returns {string}
 */
function identityCell(health, ctx) {
  const href = ctx.links.detail(health.owner, health.name);
  return `<th scope="row" class="identity">${namedLink({ href, name: health.repo })}`
    + `<span class="figure-note">Lifecycle as the archive holds it: ${escapeText(health.lifecycle)}.</span></th>`;
}

/**
 * The state cell: the state word the one health read returned, and the sentence that
 * read wrote for it. Both are text, so removing every class attribute from the page
 * leaves the state readable.
 *
 * @param {RepositoryHealth} health
 * @returns {string}
 */
function stateCell(health) {
  return `<td class="state" data-state="${escapeAttribute(health.state)}">`
    + `<span class="state-word">${escapeText(health.state)}</span> `
    + `<span class="state-reason">${escapeText(health.reason)}</span></td>`;
}

/**
 * The last-success cell: the recorded instant, or the recorded absence of one. A
 * repository no run has ever collected is shown as having no recorded success, which
 * is a different fact from a repository whose last success is old.
 *
 * @param {RepositoryHealth} health
 * @returns {string}
 */
function lastSuccessCell(health) {
  if (health.lastSuccessAt === null) {
    return `<td class="last-success" data-recorded="none">${escapeText(NO_SUCCESS_TEXT)}, so there is no `
      + 'schedule to judge.</td>';
  }
  return `<td class="last-success" data-recorded="yes">Last successful collection: `
    + `${recordedTime(health.lastSuccessAt)}.</td>`;
}

/**
 * The consecutive-failure cell: the recorded counter, in words as well as digits. Zero
 * is a recorded zero - no failure is outstanding - and not a substituted value, so it
 * is stated rather than left blank.
 *
 * @param {RepositoryHealth} health
 * @returns {string}
 */
function failureCountCell(health) {
  return `<td class="failure-count" data-count="${escapeAttribute(health.consecutiveFailures)}">`
    + `<span class="figure">${escapeText(health.consecutiveFailures)}</span> `
    + `<span class="figure-note">${escapeText(counted(health.consecutiveFailures,
      'consecutive recorded failure', 'consecutive recorded failures'))}.</span></td>`;
}

/**
 * The most-recent-failure cell: the classification, the instant and the run that
 * recorded it, and the message that was stored as evidence. Nothing here re-classifies
 * the failure or softens the message the archive kept.
 *
 * @param {RepositoryHealth} health
 * @returns {string}
 */
function lastFailureCell(health) {
  const failure = health.lastFailure;
  if (failure === null) {
    return `<td class="last-failure" data-recorded="none">${escapeText(NO_FAILURE_TEXT)}</td>`;
  }
  return `<td class="last-failure" data-recorded="yes" data-kind="${escapeAttribute(failure.kind)}">`
    + `Kind ${escapeText(failure.kind)}, recorded ${recordedTime(failure.recordedAt)} by run `
    + `${escapeText(failure.runId)}: ${escapeText(failure.message)}</td>`;
}

/**
 * The action cell: what to do, named in words, from recorded evidence only.
 *
 * The states that need something get it and the states that do not get a sentence
 * saying so. A never-collected repository is a first-connect state and carries no
 * failure action, because nothing has failed. A stalled repository's warning names the
 * last successful collection, because that recorded instant is the evidence for it. A
 * repository whose token was refused links to the guidance rendered below the table and
 * names the permission that guidance requires.
 *
 * @param {RepositoryHealth} health
 * @returns {string}
 */
function actionCell(health) {
  if (health.needsReauthentication) {
    return '<td class="action" data-action="re-authenticate">'
      + '<p class="action-lead">'
      + namedLink({
        href: `#${REAUTHENTICATE_ANCHOR}`,
        name: `Re-authenticate: the token is missing the ${TRAFFIC_PERMISSION} this repository's `
          + 'traffic endpoints require',
      })
      + '.</p>'
      + '<p class="action-step">Grant that permission for this repository, accept the permission upgrade on '
      + 'GitHub, then run <code>node src/cli.js collect</code>. A new token is the only thing that leaves the '
      + '<code>needs-re-authentication</code> state.</p></td>';
  }
  if (health.stalled && health.lastSuccessAt !== null) {
    return '<td class="action" data-action="stalled-warning">'
      + '<p class="action-lead">Collection has stopped: the last successful collection was '
      + `${recordedTime(health.lastSuccessAt)}.</p>`
      + '<p class="action-step">Check the daily schedule described in '
      + '<code>docs/operations/scheduled-collection.md</code>, then run <code>node src/cli.js collect</code>. '
      + 'A failed collection changes no stored day.</p></td>';
  }
  switch (health.state) {
    case 'unavailable':
      return '<td class="action" data-action="unavailable-note"><p>GitHub no longer serves this repository, so '
        + 'later runs exclude it. The history already recorded is kept, and there is nothing to re-collect.</p></td>';
    case 'never-collected':
      return `<td class="action" data-action="first-connect">`
        + `<p class="action-lead">${escapeText(NOT_YET_CONNECTED_TEXT)}: no collection has run for this `
        + 'repository, so nothing has failed and there is no failure to fix.</p>'
        + '<p class="action-step">Run <code>node src/cli.js collect</code> to store its first traffic days.</p></td>';
    case 'unreadable':
      return '<td class="action" data-action="unreadable-note"><p>The recorded last successful collection time '
        + 'cannot be read by this build, so this page cannot judge the schedule and names no next step from it.'
        + '</p></td>';
    case 'degraded':
      return '<td class="action" data-action="retry"><p>Run <code>node src/cli.js collect</code> again; the '
        + (health.lastFailure === null
          ? 'a failure is outstanding and this archive holds no evidence row for it, so collect again to see '
            + 'what it was.'
          : 'recorded failure above names what that failure was.')
        + ' A failed collection changes no stored day.</p></td>';
    default:
      return '<td class="action" data-action="none"><p>Nothing to do: the most recent recorded collection '
        + 'succeeded and no failure is outstanding.</p></td>';
  }
}

/**
 * One row per enrolled repository, in the archive's own order.
 *
 * @param {RepositoryHealth} health
 * @param {HealthPageContext} ctx
 * @returns {string}
 */
function repositoryRow(health, ctx) {
  return `<tr data-repository="${escapeAttribute(health.repo)}" data-state="${escapeAttribute(health.state)}">`
    + identityCell(health, ctx)
    + stateCell(health)
    + lastSuccessCell(health)
    + failureCountCell(health)
    + lastFailureCell(health)
    + actionCell(health)
    + '</tr>';
}

/**
 * The table of enrolled repositories. The caption names what the page is and what each
 * column is, so no reading of it depends on knowing the product's internals.
 *
 * @param {CollectionHealthData} data
 * @param {HealthPageContext} ctx
 * @returns {string}
 */
function repositoryTable(data, ctx) {
  return '<table class="health">'
    + '<caption>Every enrolled repository with the collection state the archive recorded: its state word and that '
    + 'state\'s own sentence, its last successful collection, how many collections have failed in a row, the most '
    + 'recent recorded failure, and what to do next. The states are the ones the CLI prints, read from the same '
    + 'place.</caption>'
    + '<thead><tr>'
    + '<th scope="col">Repository</th>'
    + '<th scope="col">Collection state</th>'
    + '<th scope="col">Last successful collection</th>'
    + '<th scope="col">Consecutive recorded failures</th>'
    + '<th scope="col">Most recent recorded failure</th>'
    + '<th scope="col">What to do</th>'
    + '</tr></thead>'
    + `<tbody>${data.repositories.map((health) => repositoryRow(health, ctx)).join('')}</tbody>`
    + '</table>';
}

/**
 * The empty case in words rather than as a table with no rows: a home that has enrolled
 * nothing is a first-connect state, and an empty table reads as a page that failed to
 * load.
 *
 * @returns {string}
 */
function emptyState() {
  return '<div class="empty-state" data-state="empty">'
    + '<p class="state-sentence">No repository is enrolled: the archive holds no enrolled repository, so this page '
    + 'has no rows to show. That is the state of the archive, not a page that failed to load, and no repository '
    + 'has failed.</p>'
    + '<p>Add an <code>owner/name</code> pair to the <code>enrolled</code> list in <code>config.json</code>, then '
    + 'run <code>node src/cli.js collect</code> to store its first traffic days.</p>'
    + '</div>';
}

/**
 * The whole-archive section: the roll-up sentence, the count behind each state in the
 * read's own precedence order, the most recent run's sentence, and the instant this
 * read was taken. All of it is the read's own wording.
 *
 * @param {CollectionHealthData} data
 * @returns {string}
 */
function wholeArchivePanel(data) {
  /** @type {string[]} */
  const counts = [];
  for (const state of REPOSITORY_STATE_PRECEDENCE) {
    const count = data.summary[SUMMARY_COUNT_FIELD[state]];
    if (count <= 0) continue;
    counts.push(`<li><span class="state-word">${escapeText(statePhrase(state))}</span>: `
      + `${escapeText(counted(count, 'enrolled repository', 'enrolled repositories'))}</li>`);
  }
  return '<p class="state-sentence" data-state="'
    + `${escapeAttribute(data.summary.state)}"><span class="state-word">`
    + `${escapeText(data.summary.state)}</span> ${escapeText(data.summary.reason)}</p>`
    + `<p class="enrolled-count">${escapeText(counted(data.summary.enrolled, 'repository', 'repositories'))} `
    + 'enrolled in this archive.</p>'
    + `<ul class="state-counts">${counts}</ul>`
    + `<p class="run-state">Most recent recorded run: ${escapeText(data.run.reason)}</p>`
    + `<p class="read-at">This page read the archive at ${recordedTime(data.readAt)}, and reports only what the `
    + 'archive held at that instant.</p>';
}

/**
 * The re-authentication section: the guidance a `needs-re-authentication` row links to,
 * rendered on the page itself so the action link resolves without leaving the dashboard
 * and without naming a remote host. The operations runbook is named as a file path
 * rather than linked, because the dashboard serves its own pages and never a file from
 * outside the view registry.
 *
 * @returns {string}
 */
function reauthenticationPanel() {
  return `<p class="section-lead">A repository whose state word is <code>needs-re-authentication</code> was refused `
    + `a credential that only a new token replaces. The traffic endpoints need the ${escapeText(TRAFFIC_PERMISSION)}; `
    + 'a 403 from one of them is reported on this page as this state with this action, never as a missing number '
    + 'and never as a general error.</p>'
    + `<ol class="reauthentication-steps">`
    + `<li>Grant the ${escapeText(TRAFFIC_PERMISSION)} to the fine-grained token for the enrolled repositories that `
    + 'need it. No other permission is requested, and nothing here asks for write access.</li>'
    + '<li>Replace the token in the home credential file, which is held at mode 0600, then run '
    + '<code>node src/cli.js config check</code> to see what the stored credential can read.</li>'
    + '<li>Accept the permission upgrade on the repository\'s page on GitHub, then run '
    + '<code>node src/cli.js collect</code>. The state returns to <code>healthy</code> when a collection succeeds '
    + 'and the archive records that success.</li>'
    + '</ol>'
    + '<p class="figure-note">The full guidance is <code>docs/operations/troubleshooting.md</code> in this '
    + 'repository. The rows above link to this section by its anchor, so the action and the guidance cannot drift '
    + 'apart.</p>';
}

/**
 * The collection health page.
 *
 * The order is {@link HEALTH_SECTION_ORDER}, every section carries its own heading, and
 * the page holds exactly one `main` landmark because the shared shell owns it.
 *
 * @param {HealthPageContext} ctx
 * @param {CollectionHealthData} data
 * @returns {string} A complete document.
 */
export function renderCollectionHealthPage(ctx, data) {
  const enrolled = data.repositories.length;
  const body = [
    `<h1>Collection health</h1>`,
    '<p>One row per enrolled repository: the collection state the archive recorded, when it last collected '
    + 'successfully, how many collections have failed in a row, the most recent failure it kept, and what to do '
    + 'next. Every state word below is the one the CLI prints, read from the same place, so this page cannot report '
    + 'a different state than the command does.</p>',
    '<p class="state-note">A recorded failure stopped a collection; it did not change any stored day, and it is '
    + 'never described here as a day the archive does not hold. A day no run reached is a day with no stored row, '
    + 'not a failed collection, and this page counts neither as the other.</p>',
    section('whole-archive', wholeArchivePanel(data)),
    section('repositories',
      '<p class="section-lead">The states are words before they are anything else: each row names its state and '
      + `the sentence that read wrote for it, so a page with no styling still says what state each of the `
      + `${escapeText(counted(enrolled, 'repository', 'repositories'))} enrolled carries.</p>`
      + (enrolled === 0 ? emptyState() : repositoryTable(data, ctx))),
    section('re-authentication', reauthenticationPanel(), REAUTHENTICATE_ANCHOR),
    '<p class="way-on">'
    + namedLink({ href: ctx.links.list, name: 'Enrolled repositories' })
    + ' &middot; '
    + namedLink({ href: ctx.links.index, name: 'Back to the index' })
    + '</p>',
  ].join('\n');
  return documentShell({ title: `Collection health - ${TITLE_SUFFIX}`, body });
}