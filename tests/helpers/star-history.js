/**
 * Star-history fixtures in the shape GitHub serves.
 *
 * The `/repos/{owner}/{repo}/stargazers` listing is restricted to admins and
 * collaborators from July 2026, so the backfill reads `/stargazers/history`
 * instead: an array of weeks, newest first, each `{ week, total, days[7] }` where
 * `week` is a UTC midnight and `days` counts stars per day of that week from
 * Sunday. `/stargazers/history` was not included in the restriction.
 * @see https://docs.github.com/en/rest/activity/starring#list-repository-star-history
 */

/** A UTC midnight, whole days after 2026-01-05 (a Sunday). @param {number} daysAgo */
export function starWeekStart(daysAgo) {
  return Math.floor(Date.parse('2026-01-05T00:00:00.000Z') / 1000) - daysAgo * 86_400;
}

/**
 * One week with the given Sunday-first daily counts and the total GitHub would send.
 * @param {number} daysAgo Days ago the week began.
 * @param {number[]} days Seven counts, Sunday first.
 * @returns {{week: number, total: number, days: number[]}}
 */
export function starWeek(daysAgo, days) {
  return { week: starWeekStart(daysAgo), total: days.reduce((sum, day) => sum + day, 0), days };
}

/**
 * A single served page: one week carrying `stars` on one day, plus a quiet week so
 * the payload is never a lone entry. Newest first, as GitHub serves it.
 * @param {number} stars How many stars the week carries.
 * @param {number} [daysAgo] Days ago that week began.
 * @returns {Array<{week: number, total: number, days: number[]}>}
 */
export function starHistoryPage(stars, daysAgo = 21) {
  return [starWeek(0, [0, 0, 0, 0, 0, 0, 0]), starWeek(daysAgo, [0, 0, 0, stars, 0, 0, 0])];
}

/**
 * Star history equivalent to a listing of `total` `starred_at` timestamps, for a test
 * that needs some stars and does not care which days they fell on. The stars are
 * spread over two distinct days, as a real history is, and the weeks are newest first
 * as GitHub serves them.
 * @param {number} total
 * @returns {Array<{week: number, total: number, days: number[]}>}
 */
export function starHistory(total) {
  const earlier = Math.ceil(total / 2);
  const later = total - earlier;
  return [
    starWeek(0, [0, 0, 0, 0, 0, 0, 0]),
    starWeek(14, [0, 0, 0, 0, later, 0, 0]),
    starWeek(21, [0, 0, 0, earlier, 0, 0, 0]),
  ];
}