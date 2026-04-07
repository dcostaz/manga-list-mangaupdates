'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const MangaUpdatesAPIWrapper = require(path.join(
  __dirname,
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
 *   }
 * }}
 */
function createMockCacheAdapter() {
  const hooks = {
    data: new Map(),
  };

  return {
    cacheAdapter: {
      async getValue(key) {
        return hooks.data.has(key) ? hooks.data.get(key) || null : null;
      },
      async setValue(key, value) {
        hooks.data.set(key, value);
      },
    },
    hooks,
  };
}

/**
 * @returns {{
 *  client: {
 *    interceptors: { response: { use: (onFulfilled: Function, onRejected: Function) => number } },
 *    put: (url: string, payload?: unknown) => Promise<{ data: unknown, status?: number }>,
 *    get: (url: string) => Promise<{ data: unknown, status?: number }>,
 *    post: (url: string, payload?: unknown, config?: unknown) => Promise<{ data: unknown, status?: number }>
 *  },
 *  hooks: {
 *    putCalls: Array<{ url: string, payload: unknown }>,
 *    getCalls: string[],
 *    postCalls: Array<{ url: string, payload: unknown, config: unknown }>,
 *    getHandler: (url: string) => unknown,
 *    postHandler: (url: string, payload: unknown, config: unknown) => unknown
 *  }
 * }}
 */
function createMockHttpClient() {
  const hooks = {
    putCalls: [],
    getCalls: [],
    postCalls: [],
    getHandler: () => [],
    postHandler: () => ({ status: 200, data: {} }),
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
            session_token: 'wave4-token',
          },
        },
      };
    },
    async get(url) {
      hooks.getCalls.push(url);
      const out = hooks.getHandler(url);
      if (out && typeof out === 'object' && 'data' in out) {
        return out;
      }
      return { data: out };
    },
    async post(url, payload, config) {
      hooks.postCalls.push({ url, payload, config });
      const out = hooks.postHandler(url, payload, config);
      if (out && typeof out === 'object' && 'data' in out) {
        return out;
      }
      return { data: out };
    },
  };

  return { client, hooks };
}

test('wave4 write flow - updateListSeries returns 401 when not authenticated', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client } = createMockHttpClient();

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.listUpdateSeries.template': '${baseUrl}/lists/series/update',
    },
    httpClient: client,
    cacheAdapter,
  });

  const result = await wrapper.updateListSeries({
    series: { id: 1 },
    list_id: 10,
    status: { chapter: 1 },
  });

  assert.equal(result.status, 401);
  assert.equal(result.data.reason, 'Not authenticated');
});

test('wave4 write flow - updateListSeries transforms chapter and volume to positive integers', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.listUpdateSeries.template': '${baseUrl}/lists/series/update',
    },
    httpClient: client,
    cacheAdapter,
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const result = await wrapper.updateListSeries({
    series: { id: 100 },
    list_id: 22,
    status: {
      chapter: 12.9,
      volume: 3.4,
    },
  });

  assert.equal(result.status, 200);
  assert.equal(httpHooks.postCalls.length, 1);
  const postPayload = httpHooks.postCalls[0].payload;
  assert.equal(Array.isArray(postPayload), true);
  assert.deepEqual(postPayload[0], {
    series: { id: 100 },
    list_id: 22,
    status: {
      chapter: 12,
      volume: 3,
    },
  });
});

test('wave4 write flow - addListSeries normalizes single object payload to array', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.listAddSeries.template': '${baseUrl}/lists/series',
    },
    httpClient: client,
    cacheAdapter,
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const result = await wrapper.addListSeries({
    series: { id: 321 },
    list_id: 1,
  });

  assert.equal(result.status, 200);
  assert.equal(httpHooks.postCalls.length, 1);
  assert.equal(Array.isArray(httpHooks.postCalls[0].payload), true);
  assert.deepEqual(httpHooks.postCalls[0].payload[0], {
    series: { id: 321 },
    list_id: 1,
  });
});

test('wave4 write flow - updateStatus maps list_id and delegates to updateListSeries payload', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.endsWith('/lists')) {
      return [
        { list_id: 10, title: 'Reading' },
        { list_id: 20, title: 'Completed' },
      ];
    }
    return [];
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.getUserLists.template': '${baseUrl}/lists',
      'api.endpoints.listUpdateSeries.template': '${baseUrl}/lists/series/update',
    },
    httpClient: client,
    cacheAdapter,
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const result = await wrapper.updateStatus({
    trackerId: '99',
    statusCode: 20,
    progressData: {
      chapter: 77.5,
      volume: 5.2,
    },
  });

  assert.equal(result.status, 200);
  assert.equal(httpHooks.postCalls.length, 1);
  assert.deepEqual(httpHooks.postCalls[0].payload[0], {
    series: { id: 99 },
    list_id: 20,
    status: {
      chapter: 77,
      volume: 5,
    },
  });
});

test('wave4 write flow - updateStatus throws wrapped error when list cannot be resolved', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.endsWith('/lists')) {
      return [{ list_id: 1, title: 'Reading' }];
    }
    return [];
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.getUserLists.template': '${baseUrl}/lists',
      'api.endpoints.listUpdateSeries.template': '${baseUrl}/lists/series/update',
    },
    httpClient: client,
    cacheAdapter,
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  await assert.rejects(
    async () => wrapper.updateStatus({ trackerId: 10, statusCode: 99, progressData: {} }),
    /\(MangaUpdates\.updateStatus\).*Unable to find list with list_id 99/,
  );
});