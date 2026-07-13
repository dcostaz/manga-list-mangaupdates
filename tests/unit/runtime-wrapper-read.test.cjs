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
 * Plan-2026Q3-namespacedcacheadapter-user-isolation: captures the full options
 * argument on every call, not just key/value, so tests can assert
 * { userScoped: true } is actually passed at each migrated call site.
 * @returns {{
 *   cacheAdapter: {
 *     getValue: (key: string, options?: { userScoped?: boolean }) => Promise<string | null>,
 *     setValue: (key: string, value: string, ttlSeconds?: number, options?: { userScoped?: boolean }) => Promise<void>
 *   },
 *   hooks: {
 *     data: Map<string, string>,
 *     reads: Array<{ key: string, options: { userScoped?: boolean } | undefined }>,
 *     writes: Array<{ key: string, value: string, ttlSeconds: number | undefined, options: { userScoped?: boolean } | undefined }>
 *   }
 * }}
 */
function createMockCacheAdapter() {
  const hooks = {
    data: new Map(),
    reads: [],
    writes: [],
  };

  return {
    cacheAdapter: {
      async getValue(key, options) {
        hooks.reads.push({ key, options });
        return hooks.data.has(key) ? hooks.data.get(key) || null : null;
      },
      async setValue(key, value, ttlSeconds, options) {
        hooks.data.set(key, value);
        hooks.writes.push({ key, value, ttlSeconds, options });
      },
    },
    hooks,
  };
}

/**
 * @returns {{
 *  client: {
 *    interceptors: { response: { use: (onFulfilled: Function, onRejected: Function) => number } },
 *    put: (url: string, payload?: unknown) => Promise<{ data: unknown }>,
 *    get: (url: string) => Promise<{ data: unknown }>,
 *    post: (url: string, payload?: unknown) => Promise<{ data: unknown }>
 *  },
 *  hooks: {
 *    putCalls: Array<{ url: string, payload: unknown }>,
 *    getCalls: string[],
 *    postCalls: Array<{ url: string, payload: unknown }>,
 *    getHandler: (url: string) => unknown,
 *    postHandler: (url: string, payload: unknown) => unknown
 *  }
 * }}
 */
function createMockHttpClient() {
  const hooks = {
    putCalls: [],
    getCalls: [],
    postCalls: [],
    getHandler: () => [],
    postHandler: () => ({ results: [] }),
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
            session_token: 'wave3-token',
          },
        },
      };
    },
    async get(url) {
      hooks.getCalls.push(url);
      const data = hooks.getHandler(url);
      return { data };
    },
    async post(url, payload) {
      hooks.postCalls.push({ url, payload });
      const data = hooks.postHandler(url, payload);
      return { data };
    },
  };

  return { client, hooks };
}

test('wave3 token flow - getToken uses set credentials and caches token', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const token = await wrapper.getToken();
  assert.equal(token, 'wave3-token');
  assert.equal(httpHooks.putCalls.length, 1);
  assert.equal(cacheHooks.data.get('mangaupdates_session_token'), 'wave3-token');
  // Plan-2026Q3-namespacedcacheadapter-user-isolation: the token is user-derived.
  assert.deepEqual(cacheHooks.writes[0].options, { userScoped: true });
});

test('wave3 read flow - getUserLists reads from endpoint then cache', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.endsWith('/lists')) {
      return [
        { list_id: 11, name: 'reading' },
        { list_id: 12, name: 'completed' },
      ];
    }
    return [];
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.getUserLists.template': '${baseUrl}/lists',
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const first = await wrapper.getUserLists();
  assert.equal(first.length, 2);
  assert.equal(httpHooks.getCalls.length, 1);

  const second = await wrapper.getUserLists();
  assert.equal(second.length, 2);
  assert.equal(httpHooks.getCalls.length, 1);

  // Plan-2026Q3-namespacedcacheadapter-user-isolation: mangaupdates_user_lists is per-user state.
  const listsWrite = cacheHooks.writes.find((w) => w.key === 'mangaupdates_user_lists');
  assert.deepEqual(listsWrite?.options, { userScoped: true });
  const listsRead = cacheHooks.reads.find((r) => r.key === 'mangaupdates_user_lists');
  assert.deepEqual(listsRead?.options, { userScoped: true });
});

test('wave3 read flow - getSeriesListStatus returns null on 404', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.includes('/lists/series/')) {
      const error = new Error('not found');
      error.response = { status: 404 };
      throw error;
    }
    return [];
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.listGetSeriesItem.template': '${baseUrl}/lists/series/${series_id}',
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const status = await wrapper.getSeriesListStatus(99);
  assert.equal(status, null);

  // Plan-2026Q3-namespacedcacheadapter-user-isolation: getSeriesListStatus%%{id} is per-user state.
  const statusRead = cacheHooks.reads.find((r) => r.key === 'getSeriesListStatus%%99');
  assert.deepEqual(statusRead?.options, { userScoped: true });
});

test('wave3 read flow - getReadingStatusFromListId maps list index to configured status', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.endsWith('/lists')) {
      return [
        { list_id: 11, name: 'reading' },
        { list_id: 12, name: 'completed' },
      ];
    }
    return [];
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.getUserLists.template': '${baseUrl}/lists',
      'statusMapping.READING': 0,
      'statusMapping.COMPLETED': 1,
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  assert.equal(await wrapper.getReadingStatusFromListId(12), 'COMPLETED');
  assert.equal(await wrapper.getReadingStatusFromListId(999), 'READING');
});

test('wave3 read flow - getUserProgress normalizes chapter, volume, timestamp and status', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.endsWith('/lists')) {
      return [
        { list_id: 11, name: 'reading' },
      ];
    }

    if (url.includes('/lists/series/42')) {
      return {
        list_id: 11,
        status: {
          chapter: 123,
          volume: 17,
        },
        time_added: {
          timestamp: 1700000000,
        },
      };
    }

    return [];
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.getUserLists.template': '${baseUrl}/lists',
      'api.endpoints.listGetSeriesItem.template': '${baseUrl}/lists/series/${series_id}',
      'statusMapping.READING': 0,
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const progress = await wrapper.getUserProgress(42);
  assert.equal(progress.chapter, 123);
  assert.equal(progress.volume, 17);
  assert.equal(progress.status, 'READING');
  assert.equal(typeof progress.lastUpdated, 'string');

  const raw = await wrapper.getUserProgressRaw(42);
  assert.equal(raw.operation, 'getUserProgressRaw');
  assert.equal(raw.payload.chapter, 123);

  // Plan-2026Q3-namespacedcacheadapter-user-isolation: covers getSeriesListStatus's write path
  // (the 404 test above only covers the read/miss path).
  const statusWrite = cacheHooks.writes.find((w) => w.key === 'getSeriesListStatus%%42');
  assert.deepEqual(statusWrite?.options, { userScoped: true });
});

test('wave3 read flow - getSeriesUrl returns payload url when provided by series lookup', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client } = createMockHttpClient();

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });

  wrapper.getSeriesByIdRaw = async () => ({
    trackerId: 'mangaupdates',
    operation: 'getSeriesByIdRaw',
    payload: {
      series: {
        url: 'https://www.mangaupdates.com/series/example',
      },
    },
  });

  const url = await wrapper.getSeriesUrl(1);
  assert.equal(url, 'https://www.mangaupdates.com/series/example');
});

test('wave3 series detail - getSerieDetail reads endpoint and then cache', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.includes('/series/42')) {
      return {
        series_id: 42,
        title: 'Blue Lock',
      };
    }
    return [];
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.series.template': '${baseUrl}/series/${series_id}',
      'cache.ttl.seriesMetadata': 10,
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const first = await wrapper.getSerieDetail(42);
  assert.equal(first.title, 'Blue Lock');
  assert.equal(httpHooks.getCalls.length, 1);

  const second = await wrapper.getSerieDetail(42);
  assert.equal(second.title, 'Blue Lock');
  assert.equal(httpHooks.getCalls.length, 1);
});

test('wave3 series detail - getSeriesById returns normalized match payload', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.includes('/series/7')) {
      return {
        series_id: 7,
        title: 'Dandadan',
        associated: [{ title: 'Dan Da Dan' }],
        image: {
          url: {
            original: 'https://img.example/dandadan.jpg',
          },
        },
        year: 2021,
        type: 'Manga',
        genres: [{ genre: 'Action' }, { genre: 'Comedy' }],
        description: 'Aliens and spirits collide.',
        status: 'Ongoing',
        authors: [{ name: 'Yukinobu Tatsu' }],
        publishers: [{ publisher_name: 'Shueisha' }],
      };
    }
    return [];
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.series.template': '${baseUrl}/series/${series_id}',
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const detail = await wrapper.getSeriesById(7);
  assert.equal(detail.source, 'mangaupdates');
  assert.equal(detail.trackerId, 7);
  assert.equal(detail.title, 'Dandadan');
  assert.deepEqual(detail.alternativeTitles, ['Dan Da Dan']);
  assert.equal(detail.coverUrl, 'https://img.example/dandadan.jpg');
  assert.equal(detail.metadata.type, 'Manga');
  assert.deepEqual(detail.metadata.genres, ['Action', 'Comedy']);
  assert.equal(detail.matchType, 'exact');
});

test('wave3 series detail - getSeriesByIdRaw returns transport payload from detailed response', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.includes('/series/88')) {
      return {
        series_id: 88,
        title: 'Kaiju No. 8',
        url: 'https://www.mangaupdates.com/series/kaiju-no-8',
      };
    }
    return [];
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.series.template': '${baseUrl}/series/${series_id}',
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const raw = await wrapper.getSeriesByIdRaw(88);
  assert.equal(raw.operation, 'getSeriesByIdRaw');
  assert.equal(raw.payload.id, 88);
  assert.equal(raw.payload.title, 'Kaiju No. 8');
  assert.equal(raw.payload.url, 'https://www.mangaupdates.com/series/kaiju-no-8');
  assert.equal(raw.payload.series.series_id, 88);
});

test('wave3 search flow - serieSearch calls endpoint and returns results', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url, payload) => {
    if (url.endsWith('/series/search')) {
      return {
        results: [
          {
            series_id: 900,
            title: payload.search,
          },
        ],
      };
    }

    return { results: [] };
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.seriesSearch.template': '${baseUrl}/series/search',
      'cache.ttl.searchResults': 300,
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const first = await wrapper.serieSearch({ search: 'Blue Lock', perpage: 5 });
  assert.equal(first.length, 1);
  assert.equal(first[0].series_id, 900);
  assert.equal(httpHooks.postCalls.length, 1);

  const second = await wrapper.serieSearch({ search: 'Blue Lock', perpage: 5 });
  assert.equal(second.length, 1);
  assert.equal(httpHooks.postCalls.length, 1);
});

test('wave3 search flow - serieSearch useCache false bypasses cache', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = () => ({ results: [{ series_id: 1, title: 'One Piece' }] });

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.seriesSearch.template': '${baseUrl}/series/search',
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  await wrapper.serieSearch({ search: 'One Piece', perpage: 5 }, { useCache: false });
  await wrapper.serieSearch({ search: 'One Piece', perpage: 5 }, { useCache: false });
  assert.equal(httpHooks.postCalls.length, 2);
});

test('wave3 read flow - getSeriesCover returns best available image URL', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client } = createMockHttpClient();

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });

  wrapper.getSerieDetail = async () => ({
    image: {
      url: {
        original: 'https://img.example/cover-original.jpg',
        thumb: 'https://img.example/cover-thumb.jpg',
      },
    },
  });

  assert.equal(await wrapper.getSeriesCover(10), 'https://img.example/cover-original.jpg');

  wrapper.getSerieDetail = async () => ({
    image: {
      url: {
        thumb: 'https://img.example/cover-thumb.jpg',
      },
    },
  });

  assert.equal(await wrapper.getSeriesCover(10), 'https://img.example/cover-thumb.jpg');
});