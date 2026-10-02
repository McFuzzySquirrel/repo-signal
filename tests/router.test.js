import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRouter } from '../src/server/router.js';

/**
 * Build a router with recording stub renderers: no view module is imported,
 * exactly as the constraint requires, and the test asserts the route and the
 * view called.
 */
function stubRouter(/** @type {{ hasRepository?: (owner: string, name: string) => boolean }} */ overrides = {}) {
  /** @type {Array<{ view: string, ctx: any }>} */
  const calls = [];
  const make = (/** @type {string} */ name) => (/** @type {any} */ ctx) => {
    calls.push({ view: name, ctx });
    return `<p>${name} page</p>`;
  };
  const views = { index: make('index'), list: make('list'), detail: make('detail') };
  const hasRepository = overrides.hasRepository ?? (() => true);
  const router = createRouter({ views, hasRepository });
  return { router, calls };
}

/** @param {string} url */
function req(url) {
  return /** @type {any} */ ({ url });
}

test('the index route resolves to the index view', async () => {
  const { router, calls } = stubRouter();
  const res = await router(req('/'));
  assert.equal(res.status, 200);
  assert.equal(res.body, '<p>index page</p>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].view, 'index');
  assert.equal(calls[0].ctx.route, 'index');
});

test('the repository list route resolves to the list view', async () => {
  const { router, calls } = stubRouter();
  const res = await router(req('/repos'));
  assert.equal(res.status, 200);
  assert.equal(calls[0].view, 'list');
  assert.equal(calls[0].ctx.route, 'list');
});

test('the detail route resolves to the detail view with owner, name and range', async () => {
  const { router, calls } = stubRouter();
  const res = await router(req('/repo/acme/widgets?from=2026-01-01&to=2026-01-14'));
  assert.equal(res.status, 200);
  assert.equal(calls[0].view, 'detail');
  assert.equal(calls[0].ctx.route, 'detail');
  assert.equal(calls[0].ctx.owner, 'acme');
  assert.equal(calls[0].ctx.name, 'widgets');
  assert.equal(calls[0].ctx.from, '2026-01-01');
  assert.equal(calls[0].ctx.to, '2026-01-14');
});

test('a valid range is accepted and the generated links carry repository and range', async () => {
  const { router, calls } = stubRouter();
  await router(req('/repo/acme/widgets?from=2026-01-01&to=2026-01-14'));
  const { links } = calls[0].ctx;
  assert.equal(links.detail('acme', 'widgets'), '/repo/acme/widgets?from=2026-01-01&to=2026-01-14');
  assert.equal(links.list, '/repos?from=2026-01-01&to=2026-01-14');
  assert.equal(links.index, '/');
});

test('an inverted range returns 400 naming the inversion before any view runs', async () => {
  const { router, calls } = stubRouter();
  const res = await router(req('/repo/acme/widgets?from=2026-01-14&to=2026-01-01'));
  assert.equal(res.status, 400);
  assert.match(res.body, /[Ii]nverted/);
  assert.match(res.body, /from 2026-01-14 is later than to 2026-01-01/);
  assert.equal(calls.length, 0, 'no view must run for an invalid range');
});

test('a malformed day returns 400 rather than being coerced', async () => {
  const { router, calls } = stubRouter();
  for (const bad of ['from=2026-1-1', 'from=not-a-day', 'to=2026-02-30', 'from=01/01/2026']) {
    const res = await router(req(`/repo/acme/widgets?${bad}`));
    assert.equal(res.status, 400, bad);
    assert.match(res.body, /[Mm]alformed/);
  }
  assert.equal(calls.length, 0);
});

test('an unknown repository returns 404 and no view runs', async () => {
  const { router, calls } = stubRouter({ hasRepository: () => false });
  const res = await router(req('/repo/acme/missing'));
  assert.equal(res.status, 404);
  assert.match(res.body, /Unknown repository/);
  assert.match(res.body, /acme\/missing/);
  assert.equal(calls.length, 0);
});

test('an unknown path returns 404 naming the path', async () => {
  const { router, calls } = stubRouter();
  const res = await router(req('/nowhere'));
  assert.equal(res.status, 404);
  assert.match(res.body, /No page matches/);
  assert.equal(calls.length, 0);
});

test('a hostile repository name is escaped in the 404 page', async () => {
  const { router } = stubRouter({ hasRepository: () => false });
  const hostile = '"><script>alert(1)</script>';
  const res = await router(req(`/repo/${encodeURIComponent(hostile)}/x`));
  assert.equal(res.status, 404);
  assert.ok(!res.body.includes(`<script>alert(1)</script>`), 'raw markup must not appear');
  assert.match(res.body, /&gt;&lt;script&gt;alert\(1\)/);
});

test('400 and 404 pages use the shared document shell', async () => {
  const { router } = stubRouter({ hasRepository: () => false });
  const res = await router(req('/repo/acme/missing?from=2026-01-14&to=2026-01-01'));
  assert.equal(res.status, 400);
  assert.match(res.body, /<html lang="en">/);
  assert.match(res.body, /class="skip-link"/);
  assert.match(res.body, /\/assets\/theme\.css/);
});
