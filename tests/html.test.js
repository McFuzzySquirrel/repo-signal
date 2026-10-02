import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentShell, escapeAttribute, escapeText, escapeUrl } from '../src/server/html.js';

const HOSTILE = `"><img src=x onerror='alert(1)'>`;

test('text context escapes angle brackets and ampersands, never emitting markup', () => {
  const out = escapeText(HOSTILE);
  assert.ok(!out.includes('<img'), out);
  assert.match(out, /&lt;img/);
  assert.equal(escapeText('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
});

test('attribute context escapes quotes so the value cannot break out', () => {
  const out = escapeAttribute(HOSTILE);
  assert.ok(!out.includes('"'), out);
  assert.match(out, /&quot;&gt;&lt;img/);
  assert.match(out, /&#39;/);
  assert.equal(escapeAttribute(`say "hi" & 'bye'`), 'say &quot;hi&quot; &amp; &#39;bye&#39;');
});

test('URL context percent-encodes quotes, spaces and angle brackets', () => {
  const out = escapeUrl(`a"b<c> d'e f`);
  assert.equal(out, 'a%22b%3Cc%3E%20d%27e%20f');
  assert.ok(!out.includes(' '), 'no space survives');
  assert.ok(!out.includes('"'), 'no quote survives');
  assert.ok(!out.includes('<'), 'no angle bracket survives');
});

test('the document shell carries language, title, stylesheet and skip link', () => {
  const html = documentShell({ title: 'Repositories - RepoSignal', body: '<h1>Repositories</h1>' });
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Repositories - RepoSignal<\/title>/);
  assert.match(html, /<link rel="stylesheet" href="\/assets\/theme\.css">/);
  const skip = html.indexOf('class="skip-link"');
  assert.ok(skip > -1, 'skip link present');
  assert.ok(skip < html.indexOf('<main'), 'skip link is the first focusable element, before any other link or main');
});

test('the shell has exactly one main landmark and escapes a hostile title', () => {
  const html = documentShell({ title: `<script>${HOSTILE}</script>`, body: '<h1>x</h1>' });
  assert.equal(html.match(/<main /g)?.length, 1);
  assert.ok(!html.includes(`<title><script>`), 'title must be escaped');
  assert.match(html, /&lt;script&gt;/);
});

test('the shell renders the same shell for any body and no remote asset', () => {
  const html = documentShell({ title: 't', body: '<p>x</p>' });
  assert.ok(!html.includes('<script'), 'no script');
  assert.ok(!/src=["']https?:/.test(html), 'no remote asset');
});
