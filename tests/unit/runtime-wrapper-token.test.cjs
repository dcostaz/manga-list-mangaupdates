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
 * @returns {{
 *   cacheAdapter: {
 *     getValue: (key: string) => Promise<string | null>,
 *     setValue: (key: string, value: string, ttlSeconds?: number) => Promise<void>
 *   },
 *   hooks: {
 *     data: Map<string, string>,
 *     writes: Array<{ key: string, value: string, ttlSeconds: number | undefined }>
 *   }
 * }}
 */
function createMockCacheAdapter() {
  const hooks = {
    data: new Map(),
    writes: [],
  };

  return {
    cacheAdapter: {
      async getValue(key) {
        return hooks.data.has(key) ? hooks.data.get(key) || null : null;
      },
      async setValue(key, value, ttlSeconds) {
        hooks.data.set(key, value);
        hooks.writes.push({ key, value, ttlSeconds });
      },
    },
    hooks,
  };
}

/**
 * @returns {{
 *  client: {
 *    interceptors: { response: { use: (onFulfilled: Function, onRejected: Function) => number } },
 *    put: (url: string, payload?: unknown) => Promise<{ data: unknown }>
 *  },
 *  hooks: {
 *    putCalls: Array<{ url: string, payload: unknown }>
 *  }
 * }}
 */
function createMockHttpClient() {
  const hooks = {
    putCalls: [],
  };

  const client = {
    interceptors: {
      response: {
        use() {
          return 0;
        },
      },
    },
    async put(url, payload) {
      hooks.putCalls.push({ url, payload });
      return {
        data: {
          context: {
            session_token: 'fresh-token',
          },
        },
      };
    },
  };

  return { client, hooks };
}

test('wave2 refresh - defaults to false and persists toggle values', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client } = createMockHttpClient();

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
    },
    httpClient: client,
    cacheAdapter,
  });

  assert.equal(await wrapper.refresh(), false);
  assert.equal(await wrapper.refresh(true), true);
  assert.equal(await wrapper.refresh(), true);
  assert.equal(await wrapper.refresh(false), false);
  assert.equal(await wrapper.refresh(), false);
});

test('wave2 token cache key and ttl - follow mangaupdates session token conventions', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client } = createMockHttpClient();

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
    },
    httpClient: client,
    cacheAdapter,
  });

  assert.equal(wrapper._getTokenCacheKey(), 'mangaupdates_session_token');
  assert.equal(wrapper._getTokenCacheKey('custom'), 'mangaupdates_custom');
  assert.equal(wrapper._getTokenTTL('session_token'), 43200);
  assert.equal(wrapper._getTokenTTL('anything-else'), 60);
});

test('wave2 token extraction and caching - extracts token and writes adapter value with ttl', async () => {
  const { cacheAdapter, hooks } = createMockCacheAdapter();
  const { client } = createMockHttpClient();

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
    },
    httpClient: client,
    cacheAdapter,
  });

  assert.equal(await wrapper._extractToken({ session_token: 'abc' }), 'abc');
  assert.equal(await wrapper._extractToken({ bad: 'shape' }), '');

  await wrapper._cacheToken({ session_token: 'cached-token' });
  assert.equal(hooks.writes.length, 1);
  assert.deepEqual(hooks.writes[0], {
    key: 'mangaupdates_session_token',
    value: 'cached-token',
    ttlSeconds: 43200,
  });
  assert.equal(wrapper.bearerToken, 'cached-token');
});

test('wave2 fetch token - returns cache hit unless forceRefresh is requested', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  cacheHooks.data.set('mangaupdates_session_token', 'from-cache');

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
    },
    httpClient: client,
    cacheAdapter,
  });

  const cached = await wrapper._fetchNewToken({ username: 'u', password: 'p' }, { forceRefresh: false });
  assert.deepEqual(cached, { session_token: 'from-cache' });
  assert.equal(httpHooks.putCalls.length, 0);

  const refreshed = await wrapper._fetchNewToken({ username: 'u', password: 'p' }, { forceRefresh: true });
  assert.deepEqual(refreshed, { session_token: 'fresh-token' });
  assert.equal(httpHooks.putCalls.length, 1);
  assert.equal(httpHooks.putCalls[0].url, 'https://api.mangaupdates.com/v1/account/login');
});

test('wave2 fetch token - missing login config still fails fast', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client } = createMockHttpClient();

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
    },
    httpClient: client,
    cacheAdapter,
  });

  await assert.rejects(
    async () => wrapper._fetchNewToken({ username: 'u', password: 'p' }, { forceRefresh: true }),
    /Missing login config/,
  );
});