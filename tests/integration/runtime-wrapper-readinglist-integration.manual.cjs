'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const MangaUpdatesAPIWrapper = require(path.join(
  __dirname,
  '..',
  '..',
  'src',
  'runtime',
  'apiwrappers',
  'reg-mangaupdates',
  'api-wrapper-mangaupdates.cjs',
));
const {
  buildEffectiveSettingsDocument,
} = require(path.join(
  __dirname,
  '..',
  '..',
  'scripts',
  'build-runtime-plugin-package.cjs',
));

const shouldSkip = process.env.ENABLE_REAL_READINGLIST_TEST !== '1'
  || process.env.CI === 'true';

function isTruthy(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function createFetchHttpClient() {
  return {
    interceptors: { response: { use() { return 0; } } },
    async put(url, payload, config = {}) {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(config.headers || {}) },
        body: JSON.stringify(payload || {}),
      });
      const rawText = await response.text();
      let data = null;
      try { data = rawText ? JSON.parse(rawText) : null; } catch { data = rawText; }
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), data };
    },
    async get(url, config = {}) {
      const response = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json', ...(config.headers || {}) } });
      const rawText = await response.text();
      let data = null;
      try { data = rawText ? JSON.parse(rawText) : null; } catch { data = rawText; }
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), data };
    },
    async post(url, payload, config = {}) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(config.headers || {}) },
        body: JSON.stringify(payload || {}),
      });
      const rawText = await response.text();
      let data = null;
      try { data = rawText ? JSON.parse(rawText) : null; } catch { data = rawText; }
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), data };
    },
  };
}

test(
  'interactive readinglist integration - fetches the real MangaUpdates reading list across every list',
  {
    skip: shouldSkip && 'Set ENABLE_REAL_READINGLIST_TEST=1 and run locally (not CI).',
    timeout: 120000,
  },
  async () => {
    const verbose = process.env.MU_TEST_VERBOSE === undefined || isTruthy(process.env.MU_TEST_VERBOSE);
    const showFullPayload = isTruthy(process.env.MU_TEST_SHOW_FULL_PAYLOAD);

    const username = typeof process.env.MU_TEST_USERNAME === 'string' ? process.env.MU_TEST_USERNAME.trim() : '';
    const password = typeof process.env.MU_TEST_PASSWORD === 'string' ? process.env.MU_TEST_PASSWORD.trim() : '';

    assert.ok(username, 'MU_TEST_USERNAME is required.');
    assert.ok(password, 'MU_TEST_PASSWORD is required.');

    if (verbose) {
      process.stdout.write('[readinglist-test] Initializing wrapper and authenticating...\n');
    }

    const effectiveSettings = buildEffectiveSettingsDocument();
    const wrapper = await MangaUpdatesAPIWrapper.init({
      serviceSettings: effectiveSettings.settings,
      httpClient: createFetchHttpClient(),
    });

    await wrapper.setCredentials({ username, password });

    const startedAt = Date.now();
    const entries = await wrapper.getReadingList({ useCache: false });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(Array.isArray(entries), true);

    const byStatus = entries.reduce((acc, entry) => {
      acc[entry.status] = (acc[entry.status] || 0) + 1;
      return acc;
    }, {});
    const missingChapter = entries.filter((e) => e.chapter === null).length;
    const missingUrl = entries.filter((e) => !e.canonicalUrl).length;
    const missingTitle = entries.filter((e) => !e.title).length;

    if (verbose) {
      process.stdout.write(`[readinglist-test] Fetched ${entries.length} entries in ${elapsedMs}ms\n`);
      process.stdout.write(`[readinglist-test] By status: ${JSON.stringify(byStatus)}\n`);
      process.stdout.write(`[readinglist-test] Missing chapter: ${missingChapter}, missing url: ${missingUrl}, missing title: ${missingTitle}\n`);
      if (entries.length > 0) {
        process.stdout.write(`[readinglist-test] First entry: ${JSON.stringify(entries[0], null, 2)}\n`);
      }
      if (showFullPayload) {
        process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
      }
      process.stdout.write('[readinglist-test] Reading-list integration test completed successfully.\n');
    }
  },
);
