'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

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

/**
 * @returns {{
 *  client: {
 *    interceptors: { response: { use: (onFulfilled: Function, onRejected: Function) => number } },
 *    put: (url: string, payload?: unknown) => Promise<{ data: unknown }>
 *  },
 *  hooks: {
 *    onFulfilled: Function | null,
 *    onRejected: Function | null,
 *    putCalls: Array<{ url: string, payload: unknown }>
 *  }
 * }}
 */
function createMockHttpClient() {
  const hooks = {
    onFulfilled: null,
    onRejected: null,
    putCalls: [],
  };

  const client = {
    interceptors: {
      response: {
        use(onFulfilled, onRejected) {
          hooks.onFulfilled = onFulfilled;
          hooks.onRejected = onRejected;
          return 0;
        },
      },
    },
    async put(url, payload) {
      hooks.putCalls.push({ url, payload });
      return {
        data: {
          context: {
            session_token: 'mock-session-token',
          },
        },
      };
    },
  };

  return { client, hooks };
}

/**
 * @returns {Promise<string>}
 */
async function createTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'manga-list-mangaupdates-wave1-test-'));
}

test('wave1 init path - serviceSettings resolve from apiSettings when not provided directly', async () => {
  const effective = buildEffectiveSettingsDocument();
  const tempDir = await createTempDir();
  const settingsPath = path.join(tempDir, 'effective-settings.json');
  await fs.writeFile(settingsPath, JSON.stringify(effective, null, 2), 'utf8');

  try {
    const { client } = createMockHttpClient();
    const wrapper = await MangaUpdatesAPIWrapper.init({
      settingsPath,
      httpClient: client,
    });

    assert.equal(wrapper.settings['api.baseUrl'], 'https://api.mangaupdates.com/v1');
    assert.equal(typeof wrapper.onCredentialsRequired, 'function');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('wave1 init path - serviceSettings override apiSettings legacy payload', async () => {
  const { client } = createMockHttpClient();
  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://override.example',
      'api.endpoints.login.template': '${baseUrl}/login',
    },
    httpClient: client,
  });

  assert.equal(wrapper.settings['api.baseUrl'], 'https://override.example');
});

test('wave1 interceptor - HTML response errors are normalized into infrastructure errors', async () => {
  const { client, hooks } = createMockHttpClient();
  await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
    },
    httpClient: client,
  });

  assert.equal(typeof hooks.onRejected, 'function');

  await assert.rejects(
    async () => hooks.onRejected({
      response: {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        data: '<html><head><title>Service Unavailable</title></head><body>Down</body></html>',
      },
    }),
    (error) => {
      assert.equal(error.name, 'MangaUpdatesBackendError');
      assert.equal(error.isInfrastructureError, true);
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /infrastructure error/i);
      return true;
    },
  );
});

test('wave1 interceptor - non HTML errors pass through untouched', async () => {
  const { client, hooks } = createMockHttpClient();
  await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
    },
    httpClient: client,
  });

  const originalError = {
    response: {
      status: 400,
      headers: { 'content-type': 'application/json' },
      data: { error: 'bad request' },
    },
  };

  await assert.rejects(
    async () => hooks.onRejected(originalError),
    (error) => {
      assert.equal(error, originalError);
      return true;
    },
  );
});

test('wave1 credentials - valid token response returns true and calls login endpoint', async () => {
  const { client, hooks } = createMockHttpClient();
  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
    },
    httpClient: client,
  });

  const valid = await wrapper.testCredentials({
    username: 'demo',
    password: 'secret',
  });

  assert.equal(valid, true);
  assert.equal(hooks.putCalls.length, 1);
  assert.equal(hooks.putCalls[0].url, 'https://api.mangaupdates.com/v1/account/login');
});

test('wave1 credentials - missing endpoint config returns false', async () => {
  const { client } = createMockHttpClient();
  const wrapper = await MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
    },
    httpClient: client,
  });

  const valid = await wrapper.testCredentials({
    username: 'demo',
    password: 'secret',
  });
  assert.equal(valid, false);
});

test('wave1 runtime contract - serviceName static getter remains stable', () => {
  assert.equal(MangaUpdatesAPIWrapper.serviceName, 'mangaupdates');
});