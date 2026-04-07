'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');

const MangaUpdatesAPISettings = require(path.join(
  __dirname,
  '..',
  'src',
  'runtime',
  'apiwrappers',
  'reg-mangaupdates',
  'api-settings-mangaupdates.cjs',
));
const {
  buildEffectiveSettingsDocument,
} = require(path.join(
  __dirname,
  '..',
  'scripts',
  'build-runtime-tracker-package.cjs',
));

const mangaupdatesValuesPath = path.join(
  __dirname,
  '..',
  'src',
  'runtime',
  'apiwrappers',
  'reg-mangaupdates',
  'mangaupdates-api-settings.values.json',
);
const mangadexValuesPath = path.join(
  __dirname,
  '..',
  '..',
  'manga-list-mangadex',
  'src',
  'runtime',
  'apiwrappers',
  'reg-mangadex',
  'mangadex-api-settings.values.json',
);

/**
 * @returns {Promise<string>}
 */
async function createTempDir() {
  return await fsPromises.mkdtemp(path.join(os.tmpdir(), 'manga-list-mangaupdates-settings-test-'));
}

/**
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} settingsDocument
 * @returns {string[]}
 */
function getEndpointTemplateKeys(settingsDocument) {
  const settings = isObject(settingsDocument.settings) ? settingsDocument.settings : {};
  return Object.keys(settings)
    .filter((key) => key.startsWith('api.endpoints.') && key.endsWith('.template'))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * @param {Record<string, unknown>} settingsDocument
 * @returns {string[]}
 */
function getEndpointThrottleKeys(settingsDocument) {
  const settings = isObject(settingsDocument.settings) ? settingsDocument.settings : {};
  return Object.keys(settings)
    .filter((key) => key.startsWith('rateLimit.perEndpoint.') && key !== 'rateLimit.perEndpoint.enabled')
    .sort((a, b) => a.localeCompare(b));
}

/**
 * @param {Record<string, unknown>} settingsDocument
 * @param {string} trackerName
 */
function assertBaselineMatrix(settingsDocument, trackerName) {
  assert.equal(isObject(settingsDocument.metadata), true, `${trackerName} metadata should exist`);
  assert.equal(isObject(settingsDocument.settings), true, `${trackerName} settings should exist`);

  const settings = /** @type {Record<string, unknown>} */ (settingsDocument.settings);

  assert.equal(typeof settings['api.baseUrl'], 'string', `${trackerName} api.baseUrl must be a string`);
  assert.equal(typeof settings['connection.timeout.connect'], 'number', `${trackerName} connection timeout.connect must be a number`);
  assert.equal(typeof settings['connection.timeout.request'], 'number', `${trackerName} connection timeout.request must be a number`);
  assert.ok(getEndpointTemplateKeys(settingsDocument).length > 0, `${trackerName} must define endpoint template keys`);

  assert.equal(typeof settings['cache.enabled'], 'boolean', `${trackerName} cache.enabled must be a boolean`);
  assert.equal(typeof settings['cache.provider'], 'string', `${trackerName} cache.provider must be a string`);
  assert.equal(typeof settings['cache.ttl.default'], 'number', `${trackerName} cache.ttl.default must be a number`);
  assert.ok(
    Object.keys(settings).some((key) => key.startsWith('cache.ttl.') && /token|session/i.test(key)),
    `${trackerName} must define token/session cache TTL settings`,
  );

  assert.equal(typeof settings['retry.enabled'], 'boolean', `${trackerName} retry.enabled must be a boolean`);
  assert.equal(typeof settings['retry.maxAttempts'], 'number', `${trackerName} retry.maxAttempts must be a number`);
  assert.equal(typeof settings['retry.backoff.type'], 'string', `${trackerName} retry.backoff.type must be a string`);
  assert.equal(Array.isArray(settings['retry.retryableErrors']), true, `${trackerName} retry.retryableErrors must be an array`);
  assert.equal(typeof settings['rateLimit.global.enabled'], 'boolean', `${trackerName} rateLimit.global.enabled must be a boolean`);
  assert.equal(typeof settings['rateLimit.perEndpoint.enabled'], 'boolean', `${trackerName} rateLimit.perEndpoint.enabled must be a boolean`);
  assert.equal(typeof settings['rateLimit.perEndpoint.defaultDelay'], 'number', `${trackerName} per-endpoint default delay must be a number`);
  assert.ok(getEndpointThrottleKeys(settingsDocument).length > 0, `${trackerName} must define per-endpoint throttle controls`);
  assert.equal(
    typeof settings['resilience.circuitBreaker.enabled'],
    'boolean',
    `${trackerName} resilience.circuitBreaker.enabled must be a boolean`,
  );
  assert.equal(typeof settings['resilience.healthCheck.enabled'], 'boolean', `${trackerName} resilience.healthCheck.enabled must be a boolean`);
}

test('settings contract - init loads merged settings payload and legacy view', async () => {
  const tempDir = await createTempDir();
  const settingsPath = path.join(tempDir, 'effective-settings.json');

  try {
    const effective = buildEffectiveSettingsDocument();
    await fsPromises.writeFile(settingsPath, JSON.stringify(effective, null, 2), 'utf8');

    const settings = await MangaUpdatesAPISettings.init({ settingsPath });
    const legacy = settings.toLegacyFormat();

    assert.equal(settings.componentName, 'MangaUpdatesAPI');
    assert.equal(legacy['api.baseUrl'], 'https://api.mangaupdates.com/v1');
    assert.equal(legacy['retry.enabled'], true);
    assert.equal(typeof legacy['cache.ttl.default'], 'number');
  } finally {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('settings contract - init rejects invalid payload shape', async () => {
  const tempDir = await createTempDir();
  const invalidPath = path.join(tempDir, 'invalid-settings.json');

  try {
    await fsPromises.writeFile(invalidPath, JSON.stringify({ settings: {} }, null, 2), 'utf8');

    await assert.rejects(
      async () => MangaUpdatesAPISettings.init({ settingsPath: invalidPath }),
      /metadata\/schema\/settings/,
    );
  } finally {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('settings contract - merged payload includes required communication, caching, and resilience fields', () => {
  const effective = buildEffectiveSettingsDocument();

  assert.equal(effective.metadata.componentName, 'MangaUpdatesAPI');
  assert.equal(typeof effective.schema['api.baseUrl'], 'object');
  assert.equal(typeof effective.schema['cache.ttl.default'], 'object');
  assert.equal(typeof effective.schema['retry.maxAttempts'], 'object');

  assert.equal(typeof effective.settings['api.baseUrl'], 'string');
  assert.equal(typeof effective.settings['connection.timeout.request'], 'number');
  assert.equal(typeof effective.settings['cache.enabled'], 'boolean');
  assert.equal(typeof effective.settings['cache.ttl.default'], 'number');
  assert.equal(typeof effective.settings['retry.enabled'], 'boolean');
  assert.equal(typeof effective.settings['rateLimit.global.enabled'], 'boolean');
  assert.equal(typeof effective.settings['resilience.circuitBreaker.enabled'], 'boolean');
});

test('settings baseline matrix - MangaUpdates baseline groups are present and typed', () => {
  const settingsDocument = loadJson(mangaupdatesValuesPath);
  assertBaselineMatrix(settingsDocument, 'mangaupdates');
});

test(
  'settings baseline matrix - MangaDex baseline groups are present and typed',
  {
    skip: !fs.existsSync(mangadexValuesPath) && 'manga-list-mangadex repository not found next to manga-list-mangaupdates',
  },
  () => {
    const settingsDocument = loadJson(mangadexValuesPath);
    assertBaselineMatrix(settingsDocument, 'mangadex');
  },
);

test(
  'settings baseline matrix - settings contract versions match between MangaUpdates and MangaDex',
  {
    skip: !fs.existsSync(mangadexValuesPath) && 'manga-list-mangadex repository not found next to manga-list-mangaupdates',
  },
  () => {
    const mangaupdates = loadJson(mangaupdatesValuesPath);
    const mangadex = loadJson(mangadexValuesPath);

    assert.equal(
      mangaupdates.metadata.settingsContractVersion,
      mangadex.metadata.settingsContractVersion,
      'settingsContractVersion should remain aligned across runtime trackers',
    );
  },
);
