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
  const { cacheAdapter, hooks } = createMockCacheAdapter();
  const { client } = createMockHttpClient();

  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });

  assert.equal(await wrapper.refresh(), false);
  assert.equal(await wrapper.refresh(true), true);
  assert.equal(await wrapper.refresh(), true);
  assert.equal(await wrapper.refresh(false), false);
  assert.equal(await wrapper.refresh(), false);

  // Plan-2026Q3-namespacedcacheadapter-user-isolation: the 'refresh' control
  // flag is user-influenced state (Decision 4) -- every read/write must be scoped.
  assert.ok(hooks.reads.every((r) => r.options?.userScoped === true), 'every refresh() read must pass userScoped: true');
  assert.ok(hooks.writes.every((w) => w.options?.userScoped === true), 'every refresh() write must pass userScoped: true');
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
    context: { cache: cacheAdapter, utils: null },
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
    context: { cache: cacheAdapter, utils: null },
  });

  assert.equal(await wrapper._extractToken({ session_token: 'abc' }), 'abc');
  assert.equal(await wrapper._extractToken({ bad: 'shape' }), '');

  await wrapper._cacheToken({ session_token: 'cached-token' });
  assert.equal(hooks.writes.length, 1);
  assert.deepEqual(hooks.writes[0], {
    // No credential applied yet: keyed by the empty credential's identity.
    key: `mangaupdates_session_token:${wrapper._credentialIdentity(null)}`,
    value: 'cached-token',
    ttlSeconds: 43200,
    options: { userScoped: true },
  });
  assert.equal(wrapper.bearerToken, 'cached-token');
});

test('wave2 fetch token - returns cache hit unless forceRefresh is requested', async () => {
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
  cacheHooks.data.set(wrapper._getTokenCacheKey(undefined, wrapper._credentialIdentity({ username: 'u' })), 'from-cache');

  const cached = await wrapper._fetchNewToken({ username: 'u', password: 'p' }, { forceRefresh: false });
  assert.deepEqual(cached, { session_token: 'from-cache' });
  assert.equal(httpHooks.putCalls.length, 0);
  assert.deepEqual(cacheHooks.reads[0].options, { userScoped: true });

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
    context: { cache: cacheAdapter, utils: null },
  });

  await assert.rejects(
    async () => wrapper._fetchNewToken({ username: 'u', password: 'p' }, { forceRefresh: true }),
    /Missing login config/,
  );
});
/**
 * An axios-shaped client whose response interceptor really runs, so the 401 replay can be tested.
 * `get` answers from `getHandler`; `request(config)` replays through the same handler.
 */
function createInterceptingHttpClient() {
  const hooks = { putCalls: [], getCalls: [], issued: 0, getHandler: () => ({ data: {} }) };
  let onRejected = null;
  const run = async (config) => {
    hooks.getCalls.push({ url: config.url, authorization: config.headers.Authorization });
    try {
      return await hooks.getHandler(config);
    } catch (error) {
      error.config = config;
      return onRejected ? onRejected(error) : Promise.reject(error);
    }
  };
  const client = {
    interceptors: { response: { use(_ok, rejected) { onRejected = rejected; return 0; } } },
    async put(url, payload) {
      hooks.putCalls.push({ url, payload });
      hooks.issued += 1;
      return { data: { context: { session_token: `session-${hooks.issued}` } } };
    },
    async get(url, options = {}) {
      return run({ url, headers: { ...(options.headers || {}) } });
    },
    async request(config) {
      return run(config);
    },
  };
  return { client, hooks };
}

function unauthorized() {
  const error = new Error('Request failed with status code 401');
  // @ts-ignore axios-shaped error
  error.response = { status: 401, headers: {}, data: {} };
  return error;
}

async function createTokenWrapper(client, cacheAdapter) {
  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
    },
    httpClient: client,
    context: { cache: cacheAdapter, utils: null },
  });
  await wrapper.setCredentials({ username: 'demo', password: 'secret' });
  return wrapper;
}

test('token expiry - an expired in-memory session token is never reused', async () => {
  const { cacheAdapter, hooks: cacheHooks } = createMockCacheAdapter();
  const { client, hooks } = createInterceptingHttpClient();
  const wrapper = await createTokenWrapper(client, cacheAdapter);

  assert.equal(await wrapper.getToken(), 'session-1');
  wrapper._bearerExpiresAt = Date.now() - 1;
  cacheHooks.data.clear();

  assert.equal(await wrapper.getToken(), 'session-2');
  assert.equal(hooks.putCalls.length, 2);
});

test('token identity - a different credential never gets the previous credential\'s token', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks } = createInterceptingHttpClient();
  const wrapper = await createTokenWrapper(client, cacheAdapter);

  assert.equal(await wrapper.getToken(), 'session-1');
  await wrapper.setCredentials({ username: 'system', password: 'pw' });
  assert.equal(wrapper.bearerToken, null, 'switching credential drops the in-memory token');
  assert.equal(await wrapper.getToken(), 'session-2');

  await wrapper.setCredentials({ username: 'demo', password: 'secret' });
  assert.equal(await wrapper.getToken(), 'session-1', 'its own token comes back from its own cache key');
  assert.equal(hooks.putCalls.length, 2);
});

test('401 replay - an authenticated request that gets a 401 signs in again and replays once', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks } = createInterceptingHttpClient();
  const wrapper = await createTokenWrapper(client, cacheAdapter);
  hooks.getHandler = (config) => {
    if (config.headers.Authorization === 'Bearer session-1') throw unauthorized();
    return { data: { ok: true } };
  };

  const token = await wrapper.getToken();
  const response = await client.get('https://api.mangaupdates.com/v1/lists', { headers: { Authorization: `Bearer ${token}` } });

  assert.deepEqual(response.data, { ok: true });
  assert.deepEqual(hooks.getCalls.map((c) => c.authorization), ['Bearer session-1', 'Bearer session-2']);
});

test('401 replay - a second 401 is returned, never looped', async () => {
  const { cacheAdapter } = createMockCacheAdapter();
  const { client, hooks } = createInterceptingHttpClient();
  const wrapper = await createTokenWrapper(client, cacheAdapter);
  hooks.getHandler = () => { throw unauthorized(); };

  const token = await wrapper.getToken();
  await assert.rejects(client.get('https://api.mangaupdates.com/v1/lists', { headers: { Authorization: `Bearer ${token}` } }), /401/);
  assert.equal(hooks.getCalls.length, 2);
});
