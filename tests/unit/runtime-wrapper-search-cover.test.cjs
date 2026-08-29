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
        hooks.data.delete(key);
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
    patchCalls: [],
    deleteCalls: [],
    putHandler: () => ({
      data: {
        context: {
          session_token: 'wave5-token',
        },
      },
    }),
    getHandler: () => ({ data: {} }),
    postHandler: () => ({ status: 200, data: { results: [] } }),
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
      hooks.putCalls.push({ url, payload, config });
      const out = hooks.putHandler(url, payload, config);
      if (out && typeof out === 'object' && 'data' in out) {
        return out;
      }
      return { data: out };
    },
    async get(url, config) {
      hooks.getCalls.push({ url, config });
      const out = hooks.getHandler(url, config);
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

/**
 * @param {CoverSearchResult} cover
 */
function assertCoverSearchContract(cover) {
  assert.equal(typeof cover.source, 'string');
  assert.equal(cover.source.length > 0, true);
  assert.equal(typeof cover.title, 'string');
  assert.equal(cover.title.length > 0, true);
  assert.equal(typeof cover.thumbnailUrl, 'string');
  assert.equal(cover.thumbnailUrl.length > 0, true);
  assert.equal(typeof cover.canonicalUrl, 'string');
  assert.equal(cover.canonicalUrl.length > 0, true);

  assert.equal(typeof cover.tracker?.id, 'string');
  assert.equal(cover.tracker.id.length > 0, true);
  assert.equal(typeof cover.tracker?.url, 'string');
  assert.equal(cover.tracker.url.length > 0, true);

  // ImageService's own bridging convention — `${seriesId}/${fileName}`, matching MangaDex's own
  // precedent (see api-wrapper-mangaupdates.cjs's _normalizeCoverSearchResult).
  assert.equal(typeof cover.coverId, 'string');
  assert.equal(cover.coverId, `${cover.tracker.id}/${cover.tracker.fileName}`);

  assert.equal(typeof cover.fetchedAt, 'string');
  assert.equal(cover.fetchedAt.length > 0, true);
  assert.equal(Number.isFinite(cover.telemetry?.durationMs), true);
  assert.equal(typeof cover.telemetry?.cacheHit, 'boolean');
  assert.equal(Number.isInteger(cover.telemetry?.attempts), true);
  assert.equal((cover.telemetry?.attempts || 0) >= 1, true);
}

test('wave5 search flow - searchTrackers returns normalized exact match from detail lookup', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).includes('/series/search')) {
      return {
        status: 200,
        data: {
          results: [
            {
              hit_title: 'Solo Leveling',
              record: {
                series_id: 321,
                title: 'Solo Leveling',
                associated: [{ title: 'Only I Level Up' }],
              },
            },
          ],
        },
      };
    }

    return { status: 200, data: { results: [] } };
  };

  httpHooks.getHandler = (url) => {
    if (String(url).includes('/series/321')) {
      return {
        status: 200,
        data: {
          series_id: 321,
          title: 'Solo Leveling',
          associated: [{ title: 'Only I Level Up' }],
          image: {
            url: {
              original: 'https://images.example/solo-leveling.jpg',
            },
          },
        },
      };
    }

    return { status: 404, data: {} };
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.seriesSearch.template': '${baseUrl}/series/search',
      'api.endpoints.series.template': '${baseUrl}/series/${series_id}',
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const matches = await wrapper.searchTrackers(
    { title: 'Solo Leveling', aliases: ['Only I Level Up'] },
    { useCache: false },
  );

  assert.equal(Array.isArray(matches), true);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].source, 'mangaupdates');
  assert.equal(matches[0].trackerId, 321);
  assert.equal(matches[0].title, 'Solo Leveling');
  assert.equal(matches[0].matchType, 'exact');
});

test('wave5 search flow - searchTrackers returns fuzzy match when exact title is unavailable', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).includes('/series/search')) {
      return {
        status: 200,
        data: {
          results: [
            {
              hit_title: 'Solo Leveling Ragnarok',
              record: {
                series_id: 322,
                title: 'Solo Leveling Ragnarok',
              },
            },
          ],
        },
      };
    }

    return { status: 200, data: { results: [] } };
  };

  httpHooks.getHandler = (url) => {
    if (String(url).includes('/series/322')) {
      return {
        status: 200,
        data: {
          series_id: 322,
          title: 'Solo Leveling Ragnarok',
          image: {
            url: {
              original: 'https://images.example/solo-leveling-ragnarok.jpg',
            },
          },
        },
      };
    }

    return { status: 404, data: {} };
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.seriesSearch.template': '${baseUrl}/series/search',
      'api.endpoints.series.template': '${baseUrl}/series/${series_id}',
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const matches = await wrapper.searchTrackers(
    { title: 'Solo Leveling' },
    { useCache: false },
  );

  assert.equal(matches.length, 1);
  assert.equal(matches[0].trackerId, 322);
  assert.equal(matches[0].matchType, 'fuzzy');
  assert.equal(matches[0].confidence, 80);
});

test('wave5 search flow - searchTrackersRaw maps transport rows from live search', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).includes('/series/search')) {
      return {
        status: 200,
        data: {
          results: [
            {
              hit_title: 'The Beginning After the End',
              record: {
                series_id: 654,
                title: 'The Beginning After the End',
              },
            },
          ],
        },
      };
    }

    return { status: 200, data: { results: [] } };
  };

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

  const raw = await wrapper.searchTrackersRaw({ title: 'The Beginning After the End' }, { useCache: false });

  assert.equal(raw.trackerId, 'mangaupdates');
  assert.equal(raw.operation, 'searchTrackersRaw');
  assert.equal(Array.isArray(raw.payload.data), true);
  assert.equal(raw.payload.data.length, 1);
  assert.equal(raw.payload.data[0]?.id, '654');
  assert.equal(raw.payload.data[0]?.title, 'The Beginning After the End');
  assert.equal(typeof raw.payload.data[0]?.record, 'object');
});

test('wave5 search flow - searchTrackersRaw prioritizes exact over fuzzy rows', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).includes('/series/search')) {
      return {
        status: 200,
        data: {
          results: [
            {
              hit_title: 'Solo Leveling Ragnarok',
              record: {
                series_id: 900,
                title: 'Solo Leveling Ragnarok',
              },
            },
            {
              hit_title: 'Solo Leveling',
              record: {
                series_id: 901,
                title: 'Solo Leveling',
              },
            },
          ],
        },
      };
    }

    return { status: 200, data: { results: [] } };
  };

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

  const raw = await wrapper.searchTrackersRaw({ title: 'Solo Leveling' }, { useCache: false });

  assert.equal(raw.payload.data.length >= 2, true);
  assert.equal(raw.payload.data[0]?.id, '901');
  assert.equal(raw.payload.data[0]?.title, 'Solo Leveling');
  assert.equal(typeof raw.payload.data[0]?.record, 'object');
});

test('wave5 search flow - searchTrackersRaw evaluates alias query after weak title results and returns exact alias snapshot', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url, payload) => {
    const query = payload && typeof payload === 'object' && typeof payload.search === 'string'
      ? payload.search
      : '';

    if (String(url).includes('/series/search') && query === 'Bad Primary Title') {
      return {
        status: 200,
        data: {
          results: [
            {
              hit_title: 'Bad Primary Title Side Story',
              record: {
                series_id: 910,
                title: 'Bad Primary Title Side Story',
              },
            },
          ],
        },
      };
    }

    if (String(url).includes('/series/search') && query === 'Great Alias Match') {
      return {
        status: 200,
        data: {
          results: [
            {
              hit_title: 'Great Alias Match',
              record: {
                series_id: 911,
                title: 'Great Alias Match',
              },
            },
          ],
        },
      };
    }

    return { status: 200, data: { results: [] } };
  };

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

  const raw = await wrapper.searchTrackersRaw(
    { title: 'Bad Primary Title', aliases: ['Great Alias Match'] },
    { useCache: false },
  );

  assert.equal(raw.payload.data.length >= 1, true);
  assert.equal(raw.payload.data[0]?.id, '911');
  assert.equal(raw.payload.data[0]?.title, 'Great Alias Match');
});

test('wave5 search flow - searchTrackers prefers highest-score title snapshot when no exact match exists', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url, payload) => {
    const query = payload && typeof payload === 'object' && typeof payload.search === 'string'
      ? payload.search
      : '';

    if (String(url).includes('/series/search') && query === 'Alpha Query') {
      return {
        status: 200,
        data: {
          results: [
            {
              hit_title: 'Alpha Distant Candidate',
              record: {
                series_id: 920,
                title: 'Alpha Distant Candidate',
              },
            },
          ],
        },
      };
    }

    if (String(url).includes('/series/search') && query === 'Solo Leveling') {
      return {
        status: 200,
        data: {
          results: [
            {
              hit_title: 'Solo Leveling Ragnarok',
              record: {
                series_id: 921,
                title: 'Solo Leveling Ragnarok',
              },
            },
          ],
        },
      };
    }

    return { status: 200, data: { results: [] } };
  };

  httpHooks.getHandler = (url) => {
    if (String(url).includes('/series/921')) {
      return {
        status: 200,
        data: {
          series_id: 921,
          title: 'Solo Leveling Ragnarok',
          image: {
            url: {
              original: 'https://images.example/solo-leveling-ragnarok.jpg',
            },
          },
        },
      };
    }

    return { status: 404, data: {} };
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.seriesSearch.template': '${baseUrl}/series/search',
      'api.endpoints.series.template': '${baseUrl}/series/${series_id}',
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const matches = await wrapper.searchTrackers(
    { title: 'Alpha Query', aliases: ['Solo Leveling'] },
    { useCache: false },
  );

  assert.equal(matches.length, 1);
  assert.equal(matches[0].trackerId, 921);
  assert.equal(matches[0].matchType, 'fuzzy');
});

test('wave5 cover flow - searchCovers resolves cover from tracker id detail', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (String(url).includes('/series/777')) {
      return {
        status: 200,
        data: {
          series_id: 777,
          title: 'Tower of God',
          url: 'https://www.mangaupdates.com/series/tower-of-god',
          image: {
            url: {
              original: 'https://images.example/tower-of-god.jpg',
            },
          },
        },
      };
    }

    return { status: 404, data: {} };
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

  const covers = await wrapper.searchCovers(
    { key: 'uuid-1', title: 'Tower of God' },
    { trackerId: 777, useCache: false },
  );

  assert.equal(Array.isArray(covers), true);
  assert.equal(covers.length, 1);
  assertCoverSearchContract(covers[0]);
  assert.equal(covers[0].source, 'mangaupdates');
  assert.equal(covers[0].tracker.id, '777');
  assert.equal(covers[0].tracker.url, 'https://images.example/tower-of-god.jpg');
  assert.equal(covers[0].tracker.fileName, 'tower-of-god.jpg');
  assert.equal(covers[0].tracker.score, 100);
  assert.equal(covers[0].thumbnailUrl, 'https://images.example/tower-of-god.jpg');
  assert.equal(typeof covers[0].canonicalUrl, 'string');
  assert.equal(covers[0].telemetry.attempts >= 1, true);
});

test('wave5 cover flow - searchCovers can return fuzzy cover candidate', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.postHandler = (url) => {
    if (String(url).includes('/series/search')) {
      return {
        status: 200,
        data: {
          results: [
            {
              hit_title: 'Tower of God Side Story',
              record: {
                series_id: 778,
                title: 'Tower of God Side Story',
              },
            },
          ],
        },
      };
    }

    return { status: 200, data: { results: [] } };
  };

  httpHooks.getHandler = (url) => {
    if (String(url).includes('/series/778')) {
      return {
        status: 200,
        data: {
          series_id: 778,
          title: 'Tower of God Side Story',
          image: {
            url: {
              original: 'https://images.example/tog-side-story.jpg',
            },
          },
        },
      };
    }

    return { status: 404, data: {} };
  };

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
      'api.endpoints.seriesSearch.template': '${baseUrl}/series/search',
      'api.endpoints.series.template': '${baseUrl}/series/${series_id}',
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const covers = await wrapper.searchCovers(
    { key: 'uuid-2', title: 'Tower of God' },
    { useCache: false },
  );

  assert.equal(covers.length, 1);
  assertCoverSearchContract(covers[0]);
  assert.equal(covers[0].tracker.id, '778');
  assert.equal(covers[0].tracker.url, 'https://images.example/tog-side-story.jpg');
  assert.equal(covers[0].tracker.score, 85);
  assert.equal(covers[0].thumbnailUrl, 'https://images.example/tog-side-story.jpg');
  assert.equal(covers[0].telemetry.attempts >= 1, true);
});

test('wave5 cover flow - downloadCover(coverId) resolves the URL via getSerieDetail, returns a Buffer, and reuses cache on second request', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  const sampleImage = Buffer.from([1, 2, 3, 4, 5]);
  httpHooks.getHandler = (url) => {
    if (String(url).includes('/series/321')) {
      return {
        status: 200,
        data: {
          series_id: 321,
          title: 'Solo Leveling',
          image: { url: { original: 'https://images.example/solo-leveling.jpg' } },
        },
      };
    }
    if (String(url) === 'https://images.example/solo-leveling.jpg') {
      return { status: 200, data: sampleImage };
    }

    return { status: 404, data: {} };
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
  // Unlike the pre-migration shape (a plain unauthenticated image GET), the new coverId-driven
  // shape re-resolves the URL via getSerieDetail(), which requires a credential.
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });

  const first = await wrapper.downloadCover('321/solo-leveling.jpg');

  assert.equal(Buffer.isBuffer(first), true);
  assert.equal(Buffer.compare(first, sampleImage), 0);
  const imageGetCall = httpHooks.getCalls.find((call) => String(call.url) === 'https://images.example/solo-leveling.jpg');
  assert.equal(Boolean(imageGetCall), true);
  const imageGetCallCount = httpHooks.getCalls.filter((call) => String(call.url) === 'https://images.example/solo-leveling.jpg').length;
  assert.equal(imageGetCallCount, 1);

  httpHooks.getHandler = (url) => {
    if (String(url) === 'https://images.example/solo-leveling.jpg') {
      throw new Error('network should not be called when the image cache is warm');
    }
    // getSerieDetail's own cache is independently warm too, but even if it weren't, only the
    // image-byte fetch is asserted never to repeat here.
    return {
      status: 200,
      data: {
        series_id: 321,
        title: 'Solo Leveling',
        image: { url: { original: 'https://images.example/solo-leveling.jpg' } },
      },
    };
  };

  const second = await wrapper.downloadCover('321/solo-leveling.jpg');

  assert.equal(Buffer.isBuffer(second), true);
  assert.equal(Buffer.compare(second, sampleImage), 0);
  const imageGetCallCountAfterSecond = httpHooks.getCalls.filter((call) => String(call.url) === 'https://images.example/solo-leveling.jpg').length;
  assert.equal(imageGetCallCountAfterSecond, 1, 'the image byte fetch must not repeat once cached, same as the pre-migration shape');
});

test('wave5 cover flow - downloadCover(coverId) rejects a malformed coverId', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client } = createMockHttpClient();

  const wrapper = await MangaUpdatesAPIWrapper.init({
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });

  await assert.rejects(() => wrapper.downloadCover('not-a-number/cover.jpg'), /Invalid coverId/);
  await assert.rejects(() => wrapper.downloadCover(''), /Invalid coverId/);
});

test('wave5 cover flow - downloadCover(coverId) throws when the series has no resolvable cover URL', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks: httpHooks } = createMockHttpClient();

  httpHooks.getHandler = (url) => {
    if (String(url).includes('/series/321')) {
      return { status: 200, data: { series_id: 321, title: 'Solo Leveling' } };
    }
    return { status: 404, data: {} };
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

  await assert.rejects(() => wrapper.downloadCover('321/cover.jpg'), /No cover URL available/);
});
