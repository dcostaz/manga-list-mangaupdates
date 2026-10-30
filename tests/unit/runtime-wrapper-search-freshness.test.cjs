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

/**
 * search() answers from this plugin's cache when it can, and says so (`cached`, `fetchedAt`); `options.refresh`
 * asks MangaUpdates itself (host-capability-contract §2.4). The host sets `refresh` only when the user asks for a
 * live search.
 */

async function createWrapper() {
  const data = new Map();
  const calls = { search: 0, detail: 0 };
  const httpClient = {
    interceptors: { response: { use: () => 0 } },
    put: async () => ({ data: { context: { session_token: 'token' } } }),
    get: async (url) => {
      if (String(url).includes('/series/321')) {
        calls.detail += 1;
        return { status: 200, data: { series_id: 321, title: 'Solo Leveling', associated: [{ title: 'Only I Level Up' }] } };
      }
      return { status: 404, data: {} };
    },
    post: async (url) => {
      if (String(url).includes('/series/search')) {
        calls.search += 1;
        return { status: 200, data: { results: [{ hit_title: 'Solo Leveling', record: { series_id: 321, title: 'Solo Leveling', associated: [{ title: 'Only I Level Up' }] } }] } };
      }
      return { status: 200, data: { results: [] } };
    },
  };
  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.seriesSearch.template': '${baseUrl}/series/search',
      'api.endpoints.series.template': '${baseUrl}/series/${series_id}',
    },
    httpClient,
    context: {
      cache: {
        async getValue(key) { return data.has(key) ? data.get(key) : null; },
        async setValue(key, value) { data.set(key, value); },
        async deleteValue(key) { data.delete(key); },
      },
      utils: null,
    },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });
  return { wrapper, calls, data };
}

test('search: a first search is live, a repeat is answered from the cache and says when it was fetched', async () => {
  const { wrapper, calls } = await createWrapper();

  const first = await wrapper.search('Solo Leveling');
  assert.equal(first.length, 1);
  assert.equal(first[0].cached, undefined, 'a live answer carries no cache marks');
  assert.equal(first[0].fetchedAt, undefined);
  assert.deepEqual([calls.search, calls.detail], [1, 1]);

  const second = await wrapper.search('Solo Leveling');
  assert.deepEqual([calls.search, calls.detail], [1, 1], 'the repeat did not reach MangaUpdates');
  assert.equal(second[0].cached, true);
  assert.ok(Number.isFinite(Date.parse(second[0].fetchedAt)));
});

test('search: refresh asks MangaUpdates itself, answers live, and refreshes the cache', async () => {
  const { wrapper, calls } = await createWrapper();
  await wrapper.search('Solo Leveling');

  const live = await wrapper.search('Solo Leveling', { refresh: true });
  assert.deepEqual([calls.search, calls.detail], [2, 2], 'the refresh reached MangaUpdates though the search was cached');
  assert.equal(live[0].cached, undefined);
  assert.equal(live[0].fetchedAt, undefined);

  const after = await wrapper.search('Solo Leveling');
  assert.deepEqual([calls.search, calls.detail], [2, 2]);
  assert.equal(after[0].cached, true);
});

test('search: an answer cached before fetch times were recorded says cached, without a time', async () => {
  const { wrapper, data } = await createWrapper();
  await wrapper.search('Solo Leveling');
  for (const [key, value] of data) {
    if (!key.startsWith('serieSearch%%') && !key.startsWith('getSerieDetail%%')) continue;
    const parsed = JSON.parse(value);
    assert.equal(parsed._v, 2, 'new entries are stamped');
    data.set(key, JSON.stringify(parsed.payload));
  }

  const cached = await wrapper.search('Solo Leveling');
  assert.equal(cached[0].cached, true);
  assert.equal(cached[0].fetchedAt, undefined);
});

test('search: a cached answer older than another part of it reports the oldest time', async () => {
  const { wrapper, data } = await createWrapper();
  await wrapper.search('Solo Leveling');
  const old = '2020-01-01T00:00:00.000Z';
  for (const [key, value] of data) {
    if (!key.startsWith('getSerieDetail%%')) continue;
    data.set(key, JSON.stringify({ ...JSON.parse(value), fetchedAt: old }));
  }

  const cached = await wrapper.search('Solo Leveling');
  assert.equal(cached[0].fetchedAt, old);
});
