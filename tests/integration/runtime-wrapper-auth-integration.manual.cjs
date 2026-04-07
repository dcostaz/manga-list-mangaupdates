'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Writable } = require('node:stream');
const readline = require('node:readline/promises');

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

const isInteractiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const shouldSkip = process.env.ENABLE_REAL_AUTH_TEST !== '1'
  || process.env.CI === 'true';

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isTruthy(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * @param {string} token
 * @returns {string}
 */
function maskToken(token) {
  if (token.length <= 12) {
    return `${token.slice(0, 2)}...`;
  }

  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function createMaskedOutputStream() {
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!output.muted) {
        process.stdout.write(chunk, encoding);
      }
      callback();
    },
  });

  output.muted = false;
  return output;
}

async function promptForCredentials() {
  const output = createMaskedOutputStream();
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });

  try {
    const username = (await rl.question('MangaUpdates username: ')).trim();

    process.stdout.write('MangaUpdates password: ');
    output.muted = true;
    const password = (await rl.question('')).trim();
    output.muted = false;
    process.stdout.write('\n');

    return { username, password };
  } finally {
    rl.close();
  }
}

function createFetchHttpClient() {
  return {
    interceptors: {
      response: {
        use() {
          return 0;
        },
      },
    },
    async put(url, payload, config = {}) {
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(config.headers || {}),
        },
        body: JSON.stringify(payload || {}),
      });

      let data = null;
      try {
        data = await response.json();
      } catch (_error) {
        data = null;
      }

      return {
        status: response.status,
        data,
      };
    },
  };
}

test(
  'interactive auth integration - requests temporary credentials and fetches a real session token',
  {
    skip: shouldSkip && 'Set ENABLE_REAL_AUTH_TEST=1 and run locally (not CI).',
    timeout: 120000,
  },
  async () => {
    const verbose = process.env.MU_TEST_VERBOSE === undefined || isTruthy(process.env.MU_TEST_VERBOSE);
    const showFullToken = isTruthy(process.env.MU_TEST_SHOW_FULL_TOKEN);

    process.stdout.write('This test uses real MangaUpdates credentials and performs a live auth request.\n');
    process.stdout.write('Use a temporary test account and rotate credentials after use.\n\n');

    const envUsername = typeof process.env.MU_TEST_USERNAME === 'string'
      ? process.env.MU_TEST_USERNAME.trim()
      : '';
    const envPassword = typeof process.env.MU_TEST_PASSWORD === 'string'
      ? process.env.MU_TEST_PASSWORD.trim()
      : '';

    let credentials = {
      username: envUsername,
      password: envPassword,
    };

    if (!credentials.username || !credentials.password) {
      if (!isInteractiveTerminal) {
        assert.fail('Missing MU_TEST_USERNAME/MU_TEST_PASSWORD and no interactive terminal is available.');
      }

      credentials = await promptForCredentials();
    }

    if (verbose) {
      const source = envUsername && envPassword ? 'environment variables' : 'interactive prompt';
      process.stdout.write(`[auth-test] Credential source: ${source}.\n`);
      process.stdout.write('[auth-test] Validating credentials against MangaUpdates login endpoint...\n');
    }

    assert.ok(credentials.username, 'Username is required.');
    assert.ok(credentials.password, 'Password is required.');

    const effectiveSettings = buildEffectiveSettingsDocument();
    const wrapper = await MangaUpdatesAPIWrapper.init({
      serviceSettings: effectiveSettings.settings,
      httpClient: createFetchHttpClient(),
    });

    const isValid = await wrapper.testCredentials(credentials);
    assert.equal(isValid, true, 'Live credentials validation failed.');

    if (verbose) {
      process.stdout.write('[auth-test] Credentials accepted. Requesting fresh session token...\n');
    }

    await wrapper.setCredentials(credentials);
    const token = await wrapper.getToken(true);

    assert.equal(typeof token, 'string');
    assert.ok(token.length > 0, 'Expected non-empty session token from live auth call.');

    if (verbose) {
      const renderedToken = showFullToken ? token : maskToken(token);
      process.stdout.write(`[auth-test] Session token generated (length=${token.length}): ${renderedToken}\n`);
      process.stdout.write('[auth-test] Auth integration test completed successfully.\n');
    }
  },
);
