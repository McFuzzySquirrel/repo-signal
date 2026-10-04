/**
 * Turn recorded archive state into plain text.
 *
 * This module derives nothing. It holds no database handle, reads no clock, opens
 * no socket and computes no figure: every number and every state word it prints was
 * read from the archive by the health, page-data and insight modules, and the
 * sentence describing a comparison is the one that module composed. Formatting here
 * is joining and labelling, so a report cannot state something the archive does not
 * hold.
 *
 * Two absences are kept apart, because collapsing them is the central way a report
 * starts lying. A day *before* a series began is a boundary: the archive honestly
 * has no reading there because nothing had been recorded yet. A day *inside* the
 * covered range is a gap: the range covers it and the archive holds nothing. The
 * boundary is named once, as a first stored day; the gaps are listed from the days
 * the range covers.
 *
 * No score, grade, threshold, verdict or trend word appears here. The states are the
 * product's own words, spelled as words.
 */

/** @typedef {import('../supervision/health.js').CollectionHealth} CollectionHealth */
/** @typedef {import('../supervision/health.js').RepositoryHealth} RepositoryHealth */
/** @typedef {import('../supervision/health.js').RunHealth} RunHealth */
/** @typedef {import('../supervision/health.js').HealthSummary} HealthSummary */

/** Days named in full before the rest are counted, matching the rest of the product. */
export const MAX_NAMED_GAP_DAYS = 10;

const RULE = '-'.repeat(72);

/**
 * The header line. Names the tool and what it read, so a pasted report says what it
 * is rather than arriving as contextless text.
 * @param {string} scope What the report is about.
 * @returns {string[]}
 */
export function header(scope) {
  return [`repo-signal report: ${scope}`, RULE];
}

/**
 * The most recent run and the enrolled-set roll-up, with the state words the health
 * read returned rather than a paraphrase of them.
 * @param {CollectionHealth} health
 * @returns {string[]}
 */
export function runBlock(health) {
  const run = health.run;
  /** @type {string[]} */
  const lines = ['', 'run', `  ${run.reason}`];
  if (run.runId !== null) {
    const parts = [
      `run=${run.runId}`,
      run.status === null ? null : `status=${run.status}`,
      `closed=${run.closedAt ?? 'not closed'}`,
      `requests=${run.requestCount}`,
      run.durationMs === null ? null : `duration_ms=${run.durationMs}`,
    ].filter((part) => part !== null);
    lines.push(`  ${parts.join(' ')}`);
  }
  lines.push(`  unclosed runs: ${run.unclosedRuns}`);
  return lines;
}

/**
 * The roll-up across the enrolled set, every state the read counted whether or not it
 * is zero. A state absent from this line is a state the read does not have.
 * @param {HealthSummary} summary
 * @returns {string[]}
 */
export function summaryBlock(summary) {
  const counted = [
    ['healthy', summary.healthy],
    ['never-collected', summary.neverCollected],
    ['degraded', summary.degraded],
    ['needs-re-authentication', summary.needsReauthentication],
    ['stalled', summary.stalled],
    ['unavailable', summary.unavailable],
    ['unreadable', summary.unreadable],
  ].filter(([, count]) => Number(count) > 0);
  const rollUp = counted.length === 0
    ? `roll-up: ${summary.reason}`
    : `roll-up: ${counted.map(([word, count]) => `${count} ${word}`).join(', ')} of ${summary.enrolled} enrolled`;
  return ['', `repositories (${summary.enrolled})`, rollUp];
}

/**
 * One line per enrolled repository: its own state word, when it last succeeded, and
 * the recorded failure streak. The streak is reported as recorded evidence, never as
 * a severity.
 * @param {RepositoryHealth[]} repositories
 * @returns {string[]}
 */
export function repositoryLines(repositories) {
  return repositories.map((repository) => {
    const owner = pad(`${repository.owner}/${repository.name}`, 34);
    const state = pad(repository.state, 24);
    const last = repository.lastSuccessAt === null
      ? 'no successful collection recorded'
      : `last success ${repository.lastSuccessAt}`;
    const failures = repository.consecutiveFailures === 0
      ? ''
      : `, ${String(repository.consecutiveFailures)} failure${repository.consecutiveFailures === 1 ? '' : 's'} recorded`;
    const cause = repository.lastFailure === null ? '' : `: ${repository.lastFailure.kind}`;
    return `  ${owner} ${state} ${last}${failures}${cause}`;
  });
}

/**
 * The recorded coverage of one metric over the selected range.
 *
 * A weekly metric is counted in weeks against the weeks the range covers, never in
 * days against a daily calendar: a day count would describe something the archive
 * does not hold.
 *
 * When the range holds no row for the metric, `firstStoredDay` is what separates the
 * two reasons. A series that began before the range is a boundary and says so; a
 * series with no stored day at all says that, and never a zero.
 * @param {object} input
 * @param {string} input.metric
 * @param {'day'|'week'} input.granularity
 * @param {import('../server/repo-data.js').PageSeries} input.series
 * @param {string[]} input.calendarDays
 * @param {string|null} input.firstStoredDay Earliest stored day for this metric, or null.
 * @returns {string}
 */
export function coverageLine({ metric, granularity, series, calendarDays, firstStoredDay }) {
  const label = pad(metric, 20);
  if (granularity === 'week') {
    return series.rows.length === 0
      ? `  ${label} no stored weeks in the selected range`
      : `  ${label} ${String(series.rows.length)} week${series.rows.length === 1 ? '' : 's'} stored`;
  }
  const stored = new Set(series.rows.map((row) => row.day));
  const covered = String(calendarDays.length);
  const rangeStart = calendarDays[0] ?? null;
  const rangeEnd = calendarDays[calendarDays.length - 1] ?? null;
  // Where the series began, relative to this range. Absent and outside are different
  // facts, so they are worded differently rather than folded into one sentence.
  /** @type {string} */
  let begins = '';
  if (firstStoredDay !== null) {
    if (rangeStart !== null && firstStoredDay < rangeStart) {
      begins = `; the series begins ${firstStoredDay}, before this range`;
    } else if (rangeEnd !== null && firstStoredDay > rangeEnd) {
      begins = `; the series begins ${firstStoredDay}, after this range`;
    } else {
      begins = `; the series begins ${firstStoredDay}`;
    }
  }
  if (stored.size === 0) {
    const none = firstStoredDay === null ? 'the archive holds no stored day for it' : begins.replace(/^; /, '');
    return `  ${label} no stored days in the ${covered}-day range, ${none}`;
  }
  const missing = calendarDays.filter((day) => !stored.has(day));
  const gaps = missing.length === 0 ? '' : `, gaps ${describeDays(missing)}`;
  return `  ${label} ${String(stored.size)} of ${covered} days stored${begins}${gaps}`;
}

/**
 * A comparison sentence, composed by the insight module that did the arithmetic, or
 * the reason it could not be composed. Printed as that module wrote it, so the numbers
 * here and the numbers on the dashboard cannot drift apart.
 * @param {string} metric
 * @param {import('../insight/deltas.js').SufficientDelta|import('../insight/deltas.js').InsufficientDelta} sevenDay
 * @param {import('../insight/deltas.js').SufficientDelta|import('../insight/deltas.js').InsufficientDelta} weekOverWeek
 * @returns {string[]}
 */
export function changeBlock(metric, sevenDay, weekOverWeek) {
  return [
    `  ${metric}`,
    `    seven-day       ${sevenDay.summary}`,
    `    week-over-week  ${weekOverWeek.summary}`,
  ];
}

/**
 * A recorded refusal, named so the absence it explains is not read as a zero. The
 * reason is the one the archive recorded.
 * @param {string|null} reason
 * @returns {string[]}
 */
export function refusalLine(reason) {
  return typeof reason === 'string' && reason !== ''
    ? [`  star history: absent \u2014 ${reason}`]
    : [];
}

/**
 * Where collected history begins, as the archive's own provenance read records it.
 *
 * This is the same boundary the chart draws its vertical rule on, read from the same
 * record rather than recomputed from stored sources, so the report and the chart
 * cannot name two different days. A repository the archive records as never
 * collected has no boundary, and none is printed: there is nothing to place.
 * @param {string|null} firstCollectedDay The recorded boundary, or null.
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
export function boundaryBlock(firstCollectedDay, from, to) {
  if (typeof firstCollectedDay !== 'string' || firstCollectedDay === '') {
    return ['  provenance: no collected history recorded yet, so every stored day here was reconstructed'];
  }
  if (firstCollectedDay > to) {
    return [`  provenance: collected from ${firstCollectedDay}, after this window of ${from} to ${to}`];
  }
  if (firstCollectedDay < from) {
    return [`  provenance: collected from ${firstCollectedDay}, before this window of ${from} to ${to}`];
  }
  return [`  provenance: reconstructed before ${firstCollectedDay}, collected from ${firstCollectedDay}`];
}

/**
 * Days named in full up to the cap, then counted. A long hole is summarised rather
 * than printed as a wall of dates, and the count is the honest total.
 * @param {string[]} days
 * @returns {string}
 */
export function describeDays(days) {
  if (days.length === 0) return 'none';
  if (days.length <= MAX_NAMED_GAP_DAYS) return days.join(', ');
  return `${days.slice(0, MAX_NAMED_GAP_DAYS).join(', ')} and ${String(days.length - MAX_NAMED_GAP_DAYS)} more`;
}

/** Right-pad to a column, so the text lines up in a terminal and in a pasted note.
 * @param {string} value @param {number} width @returns {string} */
function pad(value, width) {
  return value.length >= width ? `${value} ` : value.padEnd(width);
}