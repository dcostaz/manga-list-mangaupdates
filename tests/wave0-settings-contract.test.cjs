'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs').promises;
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

/**
 * @returns {Promise<string>}
 */
async function createTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'manga-list-mangaupdates-wave0-settings-test-'));
}

test('wave0 settings contract - init loads merged settings payload and legacy view', async () => {
  const tempDir = await createTempDir();
  const settingsPath = path.join(tempDir, 'effective-settings.json');

  try {
    const effective = buildEffectiveSettingsDocument();
    await fs.writeFile(settingsPath, JSON.stringify(effective, null, 2), 'utf8');

    const settings = await MangaUpdatesAPISettings.init({ settingsPath });
    const legacy = settings.toLegacyFormat();

    assert.equal(settings.componentName, 'MangaUpdatesAPI');
    assert.equal(legacy['api.baseUrl'], 'https://api.mangaupdates.com/v1');
    assert.equal(legacy['retry.enabled'], true);
    assert.equal(typeof legacy['cache.ttl.default'], 'number');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('wave0 settings contract - init rejects invalid payload shape', async () => {
  const tempDir = await createTempDir();
  const invalidPath = path.join(tempDir, 'invalid-settings.json');

  try {
    await fs.writeFile(invalidPath, JSON.stringify({ settings: {} }, null, 2), 'utf8');

    await assert.rejects(
      async () => MangaUpdatesAPISettings.init({ settingsPath: invalidPath }),
      /metadata\/schema\/settings/,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('wave0 settings contract - merged payload includes required communication, caching, and resilience fields', () => {
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