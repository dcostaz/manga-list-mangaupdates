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
  'build-runtime-tracker-package.cjs',
));

const shouldSkip = process.env.ENABLE_REAL_SEARCH_TEST !== '1'
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
    interceptors: {
      response: {
        use() {
          return 0;
        },
      },
    },
    async put(url, payload, config = {}) {
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(config.headers || {}),
        },
        body: JSON.stringify(payload || {}),
      });

      const rawText = await response.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch (_error) {
        data = rawText;
      }

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data,
      };
    },
    async post(url, payload, config = {}) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.headers || {}),
        },
        body: JSON.stringify(payload || {}),
      });

      const rawText = await response.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch (_error) {
        data = rawText;
      }

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data,
      };
    },
  };
}

test(
  'interactive search integration - authenticates and fetches live MangaUpdates search results',
  {
    skip: shouldSkip && 'Set ENABLE_REAL_SEARCH_TEST=1 and run locally (not CI).',
    timeout: 120000,
  },
  async () => {
    const verbose = process.env.MU_TEST_VERBOSE === undefined || isTruthy(process.env.MU_TEST_VERBOSE);
    const showFullPayload = isTruthy(process.env.MU_TEST_SHOW_FULL_SEARCH_PAYLOAD);

    const username = typeof process.env.MU_TEST_USERNAME === 'string' ? process.env.MU_TEST_USERNAME.trim() : '';
    const password = typeof process.env.MU_TEST_PASSWORD === 'string' ? process.env.MU_TEST_PASSWORD.trim() : '';
    const query = typeof process.env.MU_TEST_SEARCH_QUERY === 'string' && process.env.MU_TEST_SEARCH_QUERY.trim()
      ? process.env.MU_TEST_SEARCH_QUERY.trim()
      : 'One Piece';

    assert.ok(username, 'MU_TEST_USERNAME is required.');
    assert.ok(password, 'MU_TEST_PASSWORD is required.');

    if (verbose) {
      process.stdout.write(`[search-test] Querying MangaUpdates for: ${query}\n`);
      process.stdout.write('[search-test] Initializing wrapper and authenticating...\n');
    }

    const effectiveSettings = buildEffectiveSettingsDocument();
    const wrapper = await MangaUpdatesAPIWrapper.init({
      serviceSettings: effectiveSettings.settings,
      httpClient: createFetchHttpClient(),
    });

    await wrapper.setCredentials({ username, password });

    const raw = await wrapper.searchTrackersRaw({ title: query }, { useCache: false });

    assert.equal(raw.trackerId, 'mangaupdates');
    assert.equal(raw.operation, 'searchTrackersRaw');
    assert.equal(Array.isArray(raw.payload.data), true);
    assert.ok(raw.payload.data.length > 0, `Expected at least one search result for query '${query}'.`);

    const first = raw.payload.data[0];
    assert.equal(typeof first.id, 'string');
    assert.ok(first.id.length > 0);
    assert.equal(typeof first.title, 'string');
    assert.ok(first.title.length > 0);

    if (verbose) {
      process.stdout.write(`[search-test] Result count: ${raw.payload.data.length}\n`);
      process.stdout.write(`[search-test] First result: ${first.id} | ${first.title}\n`);
      if (showFullPayload) {
        process.stdout.write(`${JSON.stringify(raw.payload, null, 2)}\n`);
      }
      process.stdout.write('[search-test] Search integration test completed successfully.\n');
    }
  },
);
