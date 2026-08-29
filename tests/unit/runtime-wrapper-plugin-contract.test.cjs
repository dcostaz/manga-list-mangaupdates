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
            session_token: 'plugin-contract-token',
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

async function createWrapper(httpClient, cacheAdapter) {
  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.series.template': '${baseUrl}/series/${series_id}',
      'api.endpoints.getUserLists.template': '${baseUrl}/lists',
      'api.endpoints.listGetSeriesItem.template': '${baseUrl}/lists/series/${series_id}',
      'statusMapping.READING': 0,
    },
    httpClient,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });
  return wrapper;
}

// ---------------------------------------------------------------------------
// get capabilities() — must match plugin-package.json exactly (the check that
// would have caught the pre-Phase-2 plugin.live drift earlier)
// ---------------------------------------------------------------------------

test('capabilities getter matches plugin-package.json exactly', () => {
  const manifest = require(path.join(
    __dirname, '..', '..', 'src', 'runtime', 'apiwrappers', 'reg-mangaupdates', 'plugin-package.json',
  ));
  const wrapperCapabilities = MangaUpdatesAPIWrapper.prototype
    ? Object.getOwnPropertyDescriptor(MangaUpdatesAPIWrapper.prototype, 'capabilities').get.call({})
    : null;

  assert.ok(Array.isArray(wrapperCapabilities));
  assert.deepEqual([...wrapperCapabilities].sort(), [...manifest.capabilities].sort());
});

// ---------------------------------------------------------------------------
// buildLinkContribution() / syncEnrichment() — localtracker.enrich
// ---------------------------------------------------------------------------

test('buildLinkContribution - full shape with sourceLinks and mapped seriesStatus', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.includes('/series/7')) {
      return {
        series_id: 7,
        title: 'Dandadan',
        url: 'https://www.mangaupdates.com/series/dandadan',
        associated: [{ title: 'Dan Da Dan' }],
        image: { url: { original: 'https://img.example/dandadan.jpg' } },
        year: 2021,
        type: 'Manga',
        genres: [{ genre: 'Action' }, { genre: 'Comedy' }],
        description: 'Aliens and spirits collide.',
        status: 'Complete',
        authors: [{ name: 'Yukinobu Tatsu' }],
        publishers: [{ publisher_name: 'Shueisha' }],
      };
    }
    return [];
  };

  const wrapper = await createWrapper(client, cacheAdapter);
  const contribution = await wrapper.buildLinkContribution(7);

  assert.equal(contribution.pluginEntryId, '7');
  assert.equal(contribution.displayTitle, 'Dandadan');
  assert.equal(contribution.seriesStatus, 'completed');
  assert.equal(typeof contribution.syncedAt, 'string');
  assert.equal(contribution.authors.length, 1);
  assert.equal(contribution.authors[0].name, 'Yukinobu Tatsu');
  assert.deepEqual(contribution.genres, ['Action', 'Comedy']);
  assert.equal(contribution.publishers.length, 1);
  assert.equal(contribution.publishers[0].name, 'Shueisha');
  assert.equal(contribution.coverUrl, 'https://img.example/dandadan.jpg');
  assert.equal(contribution.sourceLinks.length, 1);
  assert.equal(contribution.sourceLinks[0].seriesUrl, 'https://www.mangaupdates.com/series/dandadan');
  assert.equal(contribution.sourceLinks[0].isPrimary, true);
});

test('buildLinkContribution - returns null when the series is not found', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = () => null;

  const wrapper = await createWrapper(client, cacheAdapter);
  const contribution = await wrapper.buildLinkContribution(999);

  assert.equal(contribution, null);
});

test('syncEnrichment - resolves pluginEntryId from localTrackerEntry.pluginEntryId', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.includes('/series/12')) {
      return { series_id: 12, title: 'One Piece' };
    }
    return [];
  };

  const wrapper = await createWrapper(client, cacheAdapter);
  const contribution = await wrapper.syncEnrichment({ pluginEntryId: 12 });

  assert.equal(contribution.pluginEntryId, '12');
  assert.equal(contribution.displayTitle, 'One Piece');
});

test('syncEnrichment - falls back to localTrackerEntry.plugin_entry_id (snake_case) when pluginEntryId is absent', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.includes('/series/55')) {
      return { series_id: 55, title: 'Legacy Field' };
    }
    return [];
  };

  const wrapper = await createWrapper(client, cacheAdapter);
  const contribution = await wrapper.syncEnrichment({ plugin_entry_id: 55 });

  assert.equal(contribution.pluginEntryId, '55');
});

test('syncEnrichment - returns null when neither pluginEntryId nor plugin_entry_id is present', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client } = createMockHttpClient();

  const wrapper = await createWrapper(client, cacheAdapter);
  const contribution = await wrapper.syncEnrichment({});

  assert.equal(contribution, null);
});

// ---------------------------------------------------------------------------
// pullProgress() — tracker.sync (thin alias over getUserProgress, already
// covered independently in runtime-wrapper-read.test.cjs)
// ---------------------------------------------------------------------------

test('pullProgress - delegates to getUserProgress and returns its normalized shape', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (url.endsWith('/lists')) {
      return [{ list_id: 11, name: 'reading' }];
    }
    if (url.includes('/lists/series/42')) {
      return {
        list_id: 11,
        status: { chapter: 123, volume: 17 },
        time_added: { timestamp: 1700000000 },
      };
    }
    return [];
  };

  const wrapper = await createWrapper(client, cacheAdapter);
  const progress = await wrapper.pullProgress(42);

  assert.equal(progress.chapter, 123);
  assert.equal(progress.volume, 17);
  assert.equal(progress.status, 'READING');
});

// ---------------------------------------------------------------------------
// refreshCredentials()
// ---------------------------------------------------------------------------

test('refreshCredentials - throws when no current credential is supplied', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client } = createMockHttpClient();

  const wrapper = await createWrapper(client, cacheAdapter);

  await assert.rejects(() => wrapper.refreshCredentials(null), /current credential is required/);
});

test('refreshCredentials - forces a fresh token and returns a new PluginCredential', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client } = createMockHttpClient();

  const wrapper = await createWrapper(client, cacheAdapter);
  const refreshed = await wrapper.refreshCredentials({ username: 'demo', password: 'secret', refreshToken: 'old-refresh' });

  assert.equal(refreshed.token, 'plugin-contract-token');
  assert.equal(refreshed.refreshToken, 'old-refresh');
  assert.equal(typeof refreshed.expiresAt, 'string');
});
