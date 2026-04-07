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
 *     deletedKeys: string[],
 *   }
 * }}
 */
function createMockCacheAdapter() {
  const hooks = {
    data: new Map(),
    deletedKeys: [],
  };

  return {
    cacheAdapter: {
      async getValue(key) {
        return hooks.data.has(key) ? hooks.data.get(key) || null : null;
      },
      async setValue(key, value) {
        hooks.data.set(key, value);
      },
      async deleteValue(key) {
        hooks.deletedKeys.push(key);
        hooks.data.delete(key);
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
 *    post: (url: string, payload?: unknown, config?: unknown) => Promise<{ data: unknown, status?: number }>,
 *    patch: (url: string, payload?: unknown, config?: unknown) => Promise<{ data: unknown, status?: number }>,
 *    delete: (url: string, config?: unknown) => Promise<{ data: unknown, status?: number }>
 *  },
 *  hooks: {
 *    putCalls: Array<{ url: string, payload: unknown }>,
 *    getCalls: string[],
 *    postCalls: Array<{ url: string, payload: unknown, config: unknown }>,
 *    patchCalls: Array<{ url: string, payload: unknown, config: unknown }>,
 *    deleteCalls: Array<{ url: string, config: unknown }>,
 *    putHandler: (url: string, payload: unknown, config: unknown) => unknown,
 *    getHandler: (url: string) => unknown,
 *    postHandler: (url: string, payload: unknown, config: unknown) => unknown,
 *    patchHandler: (url: string, payload: unknown, config: unknown) => unknown,
 *    deleteHandler: (url: string, config: unknown) => unknown
 *  }
 * }}
 */
function createMockHttpClient() {
  const hooks = {
    putCalls: [],
    getCalls: [],
    postCalls: [],
    patchCalls: [],
    deleteCalls: [],
    putHandler: () => ({
      data: {
        context: {
          session_token: 'wave4-token',
        },
      },
    }),
    getHandler: () => [],
    postHandler: () => ({ status: 200, data: {} }),
    patchHandler: () => ({ status: 200, data: {} }),
    deleteHandler: () => ({ status: 200, data: {} }),
  };

  const client = {
    interceptors: {
      response: {
        use() {
          return 0;
        },
      },
    },
    async put(url, payload, config) {
      hooks.putCalls.push({ url, payload });
      const out = hooks.putHandler(url, payload, config);
      if (out && typeof out === 'object' && 'data' in out) {
        return out;
      }
      return { data: out };
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
    async patch(url, payload, config) {
      hooks.patchCalls.push({ url, payload, config });
      const out = hooks.patchHandler(url, payload, config);
      if (out && typeof out === 'object' && 'data' in out) {
        return out;
      }
      return { data: out };
    },
    async delete(url, config) {
      hooks.deleteCalls.push({ url, config });
      const out = hooks.deleteHandler(url, config);
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

test('wave4 write flow - updateSerieRating updates rating endpoint payload', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.putHandler = (url) => {
    if (url.includes('/rating')) {
      return { status: 200, data: { ok: true } };
    }
    return {
      data: {
        context: {
          session_token: 'wave4-token',
        },
      },
    };
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.updateSerieRating.template': '${baseUrl}/series/${series_id}/rating',
    },
    httpClient: client,
    cacheAdapter,
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const result = await wrapper.updateSerieRating('55', { rating: 8 });
  assert.equal(result.status, 200);
  assert.equal(httpHooks.putCalls.length >= 1, true);
  const ratingCall = httpHooks.putCalls.find((call) => String(call.url).includes('/rating'));
  assert.equal(Boolean(ratingCall), true);
  assert.deepEqual(ratingCall.payload, { rating: 8 });
});

test('wave4 write flow - setUserProgress returns missing subscription error when series absent', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.includes('/lists/series/')) {
      const error = new Error('not found');
      error.response = { status: 404 };
      throw error;
    }

    if (url.endsWith('/lists')) {
      return [{ list_id: 1, title: 'Reading' }];
    }

    return [];
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.listGetSeriesItem.template': '${baseUrl}/lists/series/${series_id}',
      'api.endpoints.getUserLists.template': '${baseUrl}/lists',
      'api.endpoints.listUpdateSeries.template': '${baseUrl}/lists/series/update',
      'api.endpoints.updateSerieRating.template': '${baseUrl}/series/${series_id}/rating',
      'statusMapping.READING': 1,
    },
    httpClient: client,
    cacheAdapter,
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const result = await wrapper.setUserProgress(42, { chapter: 10 });
  assert.equal(result.success, false);
  assert.match(result.error, /Series is not present/);
});

test('wave4 write flow - setUserProgress updates list and rating and reports updated fields', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.includes('/lists/series/42')) {
      return {
        list_id: 10,
        status: { chapter: 1, volume: 1 },
      };
    }
    if (url.endsWith('/lists')) {
      return [
        { list_id: 10, title: 'Reading' },
        { list_id: 20, title: 'Completed' },
      ];
    }
    return [];
  };

  httpHooks.putHandler = (url) => {
    if (url.includes('/rating')) {
      return { status: 200, data: { ok: true } };
    }
    return {
      data: {
        context: {
          session_token: 'wave4-token',
        },
      },
    };
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.listGetSeriesItem.template': '${baseUrl}/lists/series/${series_id}',
      'api.endpoints.getUserLists.template': '${baseUrl}/lists',
      'api.endpoints.listUpdateSeries.template': '${baseUrl}/lists/series/update',
      'api.endpoints.updateSerieRating.template': '${baseUrl}/series/${series_id}/rating',
      'statusMapping.READING': 10,
      'statusMapping.COMPLETED': 20,
    },
    httpClient: client,
    cacheAdapter,
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const result = await wrapper.setUserProgress(42, {
    chapter: 12,
    volume: 2,
    status: 'COMPLETED',
    rating: 9,
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.updatedFields, ['chapter', 'volume', 'status', 'rating']);
  assert.match(result.message, /Updated chapter, volume, status, rating/);
  assert.equal(cacheHooks.deletedKeys.includes('getSeriesListStatus%%42'), true);

  const listUpdateCall = httpHooks.postCalls.find((call) => String(call.url).includes('/lists/series/update'));
  assert.equal(Boolean(listUpdateCall), true);
  assert.deepEqual(listUpdateCall.payload[0], {
    series: { id: 42 },
    list_id: 20,
    status: { chapter: 12, volume: 2 },
  });

  const ratingCall = httpHooks.putCalls.find((call) => String(call.url).includes('/rating'));
  assert.equal(Boolean(ratingCall), true);
  assert.deepEqual(ratingCall.payload, { rating: 9 });
});

test('wave4 write flow - subscribeToReadingList adds missing series and applies mapped status list', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.includes('/lists/series/61')) {
      const error = new Error('not found');
      error.response = { status: 404 };
      throw error;
    }
    if (url.endsWith('/lists')) {
      return [
        { list_id: 10, title: 'Reading' },
        { list_id: 20, title: 'Completed' },
      ];
    }
    return [];
  };

  httpHooks.putHandler = (url) => {
    if (url.includes('/rating')) {
      return { status: 200, data: { ok: true } };
    }
    return {
      data: {
        context: {
          session_token: 'wave4-token',
        },
      },
    };
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.getUserLists.template': '${baseUrl}/lists',
      'api.endpoints.listGetSeriesItem.template': '${baseUrl}/lists/series/${series_id}',
      'api.endpoints.listAddSeries.template': '${baseUrl}/lists/series',
      'api.endpoints.updateSerieRating.template': '${baseUrl}/series/${series_id}/rating',
      'statusMapping.READING': 10,
      'statusMapping.COMPLETED': 20,
    },
    httpClient: client,
    cacheAdapter,
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const result = await wrapper.subscribeToReadingList({
    seriesId: 61,
    status: 'COMPLETED',
    chapter: 20,
    volume: 5,
    rating: 8,
  });

  assert.equal(result.success, true);
  assert.equal(result.mode, 'added');
  assert.equal(result.listId, 20);
  const addCall = httpHooks.postCalls.find((call) => String(call.url).endsWith('/lists/series'));
  assert.equal(Boolean(addCall), true);
  assert.deepEqual(addCall.payload[0], {
    series: { id: 61 },
    list_id: 20,
    status: {
      chapter: 20,
      volume: 5,
    },
  });
  const ratingCall = httpHooks.putCalls.find((call) => String(call.url).includes('/rating'));
  assert.equal(Boolean(ratingCall), true);
  assert.equal(cacheHooks.deletedKeys.includes('getSeriesListStatus%%61'), true);
});

test('wave4 write flow - subscribeToReadingList updates existing series and tolerates rating failure', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.includes('/lists/series/62')) {
      return {
        list_id: 10,
        status: {
          chapter: 2,
          volume: 1,
        },
      };
    }
    if (url.endsWith('/lists')) {
      return [
        { list_id: 10, title: 'Reading' },
      ];
    }
    return [];
  };

  httpHooks.putHandler = (url) => {
    if (url.includes('/rating')) {
      return { status: 400, data: { reason: 'bad rating' } };
    }
    return {
      data: {
        context: {
          session_token: 'wave4-token',
        },
      },
    };
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.getUserLists.template': '${baseUrl}/lists',
      'api.endpoints.listGetSeriesItem.template': '${baseUrl}/lists/series/${series_id}',
      'api.endpoints.listUpdateSeries.template': '${baseUrl}/lists/series/update',
      'api.endpoints.updateSerieRating.template': '${baseUrl}/series/${series_id}/rating',
      'statusMapping.READING': 10,
    },
    httpClient: client,
    cacheAdapter,
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const result = await wrapper.subscribeToReadingList({
    seriesId: 62,
    status: 'READING',
    chapter: 3,
    rating: 4,
  });

  assert.equal(result.success, true);
  assert.equal(result.mode, 'updated');
  const updateCall = httpHooks.postCalls.find((call) => String(call.url).endsWith('/lists/series/update'));
  assert.equal(Boolean(updateCall), true);
  assert.deepEqual(updateCall.payload[0], {
    series: { id: 62 },
    list_id: 10,
    status: {
      chapter: 3,
    },
  });
  assert.equal(cacheHooks.deletedKeys.includes('getSeriesListStatus%%62'), true);
});

test('wave4 write flow - updateSeries patches series payload and invalidates detail cache', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.patchHandler = (url) => {
    if (url.includes('/series/777')) {
      return { status: 200, data: { ok: true } };
    }
    return { status: 404, data: { reason: 'missing' } };
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.series.template': '${baseUrl}/series/${series_id}',
    },
    httpClient: client,
    cacheAdapter,
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const result = await wrapper.updateSeries(777, { description: 'patched' });

  assert.equal(result.status, 200);
  assert.equal(httpHooks.patchCalls.length, 1);
  assert.match(String(httpHooks.patchCalls[0].url), /\/series\/777$/);
  assert.deepEqual(httpHooks.patchCalls[0].payload, { description: 'patched' });
  assert.equal(cacheHooks.deletedKeys.includes('getSerieDetail%%777'), true);
});

test('wave4 write flow - updateSeriesCover posts image payload and invalidates detail cache', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url, payload) => {
    if (url.includes('/series/88/image')) {
      return {
        status: 200,
        data: {
          ok: true,
          hasImage: Boolean(payload && typeof payload === 'object' && payload.image),
        },
      };
    }

    return { status: 200, data: {} };
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.seriesImage.template': '${baseUrl}/series/${series_id}/image',
    },
    httpClient: client,
    cacheAdapter,
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const result = await wrapper.updateSeriesCover(88, Buffer.from('image-bytes'));

  assert.equal(result.status, 200);
  const coverCall = httpHooks.postCalls.find((call) => String(call.url).includes('/series/88/image'));
  assert.equal(Boolean(coverCall), true);
  assert.equal(Boolean(coverCall.payload && coverCall.payload.image), true);
  assert.equal(cacheHooks.deletedKeys.includes('getSerieDetail%%88'), true);
});

test('wave4 write flow - deleteSeriesCover deletes endpoint and invalidates detail cache', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.deleteHandler = (url) => {
    if (url.includes('/series/91/image')) {
      return { status: 200, data: { ok: true } };
    }
    return { status: 404, data: { reason: 'missing' } };
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.seriesImage.template': '${baseUrl}/series/${series_id}/image',
    },
    httpClient: client,
    cacheAdapter,
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const result = await wrapper.deleteSeriesCover(91);

  assert.equal(result.status, 200);
  assert.equal(httpHooks.deleteCalls.length, 1);
  assert.match(String(httpHooks.deleteCalls[0].url), /\/series\/91\/image$/);
  assert.equal(cacheHooks.deletedKeys.includes('getSerieDetail%%91'), true);
});