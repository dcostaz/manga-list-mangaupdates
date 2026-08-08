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

function createMockCacheAdapter() {
  const data = new Map();
  return {
    async getValue(key) {
      return data.has(key) ? data.get(key) : null;
    },
    async setValue(key, value) {
      data.set(key, value);
    },
  };
}

function createMockHttpClient() {
  const hooks = {
    postCalls: [],
    postHandler: () => ({ results: [] }),
    getHandler: () => [],
  };

  const client = {
    interceptors: { response: { use: () => 0 } },
    async put() {
      return { data: { context: { session_token: 'readinglist-token' } } };
    },
    async get(url) {
      return { data: hooks.getHandler(url) };
    },
    async post(url, payload) {
      hooks.postCalls.push({ url, payload });
      return { data: hooks.postHandler(url, payload) };
    },
  };

  return { client, hooks };
}

async function initWrapper({ client, extraSettings = {} } = {}) {
  const cacheAdapter = createMockCacheAdapter();
  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.listSearch.template': '${baseUrl}/lists/${list_id}/search',
      'api.endpoints.listSearch.perPage': 2,
      'api.endpoints.listSearch.throttle': 0,
      ...extraSettings,
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });
  return wrapper;
}

function makeEntry(id, title, chapter, volume, userRating = null) {
  return {
    record: {
      series: { id, url: `https://www.mangaupdates.com/series/${id}`, title },
      list_id: 11,
      status: { chapter, volume },
      priority: 0,
      time_added: { timestamp: 1700000000 },
    },
    metadata: {
      series: {},
      user_rating: userRating,
    },
  };
}

test('getListSeries paginates until a short page, then caches', async () => {
  const { client, hooks } = createMockHttpClient();
  let callCount = 0;
  hooks.postHandler = (url) => {
    callCount += 1;
    if (url.includes('/lists/11/search') && callCount === 1) {
      return { results: [makeEntry(1, 'A', 1, 0), makeEntry(2, 'B', 2, 0)] };
    }
    if (url.includes('/lists/11/search') && callCount === 2) {
      return { results: [makeEntry(3, 'C', 3, 0)] };
    }
    return { results: [] };
  };

  const wrapper = await initWrapper({ client });
  const first = await wrapper.getListSeries(11);
  assert.equal(first.length, 3);
  assert.equal(hooks.postCalls.length, 2);

  const second = await wrapper.getListSeries(11);
  assert.equal(second.length, 3);
  assert.equal(hooks.postCalls.length, 2, 'second call should be served from cache');
});

test('getListSeries useCache:false bypasses the cache', async () => {
  const { client, hooks } = createMockHttpClient();
  hooks.postHandler = (url) => (url.includes('/lists/11/search') ? { results: [makeEntry(1, 'A', 1, 0)] } : { results: [] });

  const wrapper = await initWrapper({ client });
  await wrapper.getListSeries(11, { useCache: false });
  await wrapper.getListSeries(11, { useCache: false });
  assert.equal(hooks.postCalls.length, 2);
});

test('getReadingList aggregates across every list and tags resolved status', async () => {
  const { client, hooks } = createMockHttpClient();
  hooks.getHandler = (url) => {
    if (url.endsWith('/lists')) {
      return [
        { list_id: 11, name: 'reading' },
        { list_id: 12, name: 'completed' },
      ];
    }
    return [];
  };
  hooks.postHandler = (url) => {
    if (url.includes('/lists/11/search')) {
      return { results: [makeEntry(1, 'Reading Manga', 5, 1, 9)] };
    }
    if (url.includes('/lists/12/search')) {
      return { results: [makeEntry(2, 'Completed Manga', 100, 10, null)] };
    }
    return { results: [] };
  };

  const wrapper = await initWrapper({
    client,
    extraSettings: {
      'api.endpoints.getUserLists.template': '${baseUrl}/lists',
      'statusMapping.READING': 0,
      'statusMapping.COMPLETED': 1,
    },
  });

  const entries = await wrapper.getReadingList();
  assert.equal(entries.length, 2);

  const reading = entries.find((e) => e.pluginEntryId === '1');
  assert.equal(reading.title, 'Reading Manga');
  assert.equal(reading.canonicalUrl, 'https://www.mangaupdates.com/series/1');
  assert.equal(reading.status, 'READING');
  assert.equal(reading.chapter, 5);
  assert.equal(reading.volume, 1);
  assert.equal(typeof reading.lastUpdated, 'string');
  // rating comes from the same entry's sibling metadata.user_rating field —
  // no extra call needed (owner correction 2026-07-23, verified live: this
  // was missed in the original implementation, which only read `record`).
  assert.equal(reading.rating, 9);

  const completed = entries.find((e) => e.pluginEntryId === '2');
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.chapter, 100);
  // The API's own null sentinel for "not rated" passes through unchanged —
  // never coerced to 0 or any other invented default (R1/R2).
  assert.equal(completed.rating, null);
});

test('getReadingList: comparison stays null on every entry when hostProgressByEntryId is not supplied', async () => {
  const { client, hooks } = createMockHttpClient();
  hooks.getHandler = (url) => (url.endsWith('/lists') ? [{ list_id: 11, name: 'reading' }] : []);
  hooks.postHandler = (url) => (url.includes('/lists/11/search') ? { results: [makeEntry(1, 'A', 5, 1, 9)] } : { results: [] });

  const wrapper = await initWrapper({
    client,
    extraSettings: { 'api.endpoints.getUserLists.template': '${baseUrl}/lists', 'statusMapping.READING': 0 },
  });

  const entries = await wrapper.getReadingList();
  assert.equal(entries[0].comparison, null);
});

test('getReadingList: hostProgressByEntryId enriches matching entries with a per-entry comparison, in line with compareProgress() (owner direction 2026-07-23)', async () => {
  const { client, hooks } = createMockHttpClient();
  hooks.getHandler = (url) => (url.endsWith('/lists') ? [{ list_id: 11, name: 'reading' }] : []);
  hooks.postHandler = (url) => {
    if (url.includes('/lists/11/search')) {
      // remote chapter 45 (integer, as MangaUpdates always is), rating 9
      return { results: [makeEntry(1, 'A', 45, 1, 9)] };
    }
    return { results: [] };
  };

  const wrapper = await initWrapper({
    client,
    extraSettings: { 'api.endpoints.getUserLists.template': '${baseUrl}/lists', 'statusMapping.READING': 0 },
  });

  // Host has a fractional chapter (45.5) — must compare on the integer part
  // only, not report a false "ahead"/"behind" from the fractional part.
  const hostProgressByEntryId = new Map([['1', { status: 'READING', chapter: 45.5, rating: 9 }]]);
  const entries = await wrapper.getReadingList({ hostProgressByEntryId });

  assert.ok(entries[0].comparison);
  assert.equal(entries[0].comparison.chapterAhead, false);
  assert.equal(entries[0].comparison.chapterBehindOrEqual, true);
  assert.equal(entries[0].comparison.ratingDiffers, false);
  assert.equal(entries[0].comparison.statusDiffers, false);
});

test('getReadingList: entries with no matching hostProgressByEntryId key keep comparison null', async () => {
  const { client, hooks } = createMockHttpClient();
  hooks.getHandler = (url) => (url.endsWith('/lists') ? [{ list_id: 11, name: 'reading' }] : []);
  hooks.postHandler = (url) => (url.includes('/lists/11/search') ? { results: [makeEntry(1, 'A', 5, 1, 9)] } : { results: [] });

  const wrapper = await initWrapper({
    client,
    extraSettings: { 'api.endpoints.getUserLists.template': '${baseUrl}/lists', 'statusMapping.READING': 0 },
  });

  const hostProgressByEntryId = new Map([['999', { status: 'READING', chapter: 1 }]]);
  const entries = await wrapper.getReadingList({ hostProgressByEntryId });
  assert.equal(entries[0].comparison, null);
});

test('getReadingList returns empty when the account has no lists', async () => {
  const { client, hooks } = createMockHttpClient();
  hooks.getHandler = (url) => (url.endsWith('/lists') ? [] : []);

  const wrapper = await initWrapper({
    client,
    extraSettings: { 'api.endpoints.getUserLists.template': '${baseUrl}/lists' },
  });

  const entries = await wrapper.getReadingList();
  assert.deepEqual(entries, []);
});

test('getReadingList skips malformed entries missing a series id', async () => {
  const { client, hooks } = createMockHttpClient();
  hooks.getHandler = (url) => (url.endsWith('/lists') ? [{ list_id: 11, name: 'reading' }] : []);
  hooks.postHandler = (url) => {
    if (url.includes('/lists/11/search')) {
      return { results: [{ record: { series: {}, status: {} } }] };
    }
    return { results: [] };
  };

  const wrapper = await initWrapper({
    client,
    extraSettings: { 'api.endpoints.getUserLists.template': '${baseUrl}/lists' },
  });

  const entries = await wrapper.getReadingList();
  assert.deepEqual(entries, []);
});
