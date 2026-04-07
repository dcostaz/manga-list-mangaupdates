'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const JSZip = require('jszip');
const {
  TRACKER_SETTINGS_CONTRACT_VERSION,
} = require('../src/runtime/apiwrappers/trackerdtocontract.cjs');

const {
  buildRuntimeTrackerPackage,
  buildEffectiveSettingsDocument,
  buildManifest,
} = require('../scripts/build-runtime-tracker-package.cjs');

/**
 * @returns {Promise<string>}
 */
async function createTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'manga-list-mangaupdates-build-test-'));
}

test('buildManifest returns runtime loader compatible metadata', () => {
  const manifest = buildManifest('1.0.0');

  assert.equal(manifest.serviceName, 'mangaupdates');
  assert.equal(manifest.wrapperId, 'mangaupdates');
  assert.equal(manifest.hostApiVersion, '1.0.0');
  assert.equal(typeof manifest.dtoContractVersion, 'string');
  assert.equal(manifest.entrypoints.trackerModule, 'apiwrappers/reg-mangaupdates/tracker-module.cjs');
  assert.equal(manifest.entrypoints.mapperModule, 'apiwrappers/reg-mangaupdates/mapper-mangaupdates.cjs');
  // settingsFile points to the build-generated effective payload, not a source-controlled file.
  assert.equal(manifest.entrypoints.settingsFile, 'apiwrappers/reg-mangaupdates/mangaupdates-api-settings.json');
});

test('exports centralized tracker settings contract version', () => {
  assert.equal(typeof TRACKER_SETTINGS_CONTRACT_VERSION, 'string');
  assert.equal(TRACKER_SETTINGS_CONTRACT_VERSION, '1.0.0');
});

test('buildEffectiveSettingsDocument merges definition and values into runtime payload', () => {
  const effective = buildEffectiveSettingsDocument();

  assert.equal(effective.metadata.componentName, 'MangaUpdatesAPI');
  assert.equal(effective.metadata.settingsContractVersion, TRACKER_SETTINGS_CONTRACT_VERSION);
  assert.equal(typeof effective.schema['api.baseUrl'], 'object');
  assert.equal(typeof effective.schema['api.endpoints.series.template'], 'object');
  assert.equal(typeof effective.schema['api.endpoints.seriesImage.template'], 'object');
  assert.equal(effective.settings['api.baseUrl'], 'https://api.mangaupdates.com/v1');
  assert.equal(effective.settings['api.endpoints.series.template'], '${baseUrl}/series/${series_id}');
  assert.equal(effective.settings['api.endpoints.seriesImage.template'], '${baseUrl}/series/${series_id}/image');
  assert.equal(effective.settings['rateLimit.perEndpoint.seriesImage'], 1000);
  assert.equal(effective.settings['statusMapping.READING'], 0);
});

test('buildRuntimeTrackerPackage creates zip with tracker-package.json and runtime files', async () => {
  const tempDir = await createTempDir();
  const outputPath = path.join(tempDir, 'mangaupdates-runtime.zip');

  try {
    const result = await buildRuntimeTrackerPackage({ outputPath, hostApiVersion: '1.2.3' });
    assert.equal(result.outputPath, outputPath);

    const zipBuffer = await fs.readFile(outputPath);
    const zip = await JSZip.loadAsync(zipBuffer);
    const entries = Object.keys(zip.files)
      .filter((entry) => !entry.endsWith('/'))
      .sort((a, b) => a.localeCompare(b));

    assert.deepEqual(entries, [
      'apiwrappers/reg-mangaupdates/api-settings-mangaupdates.cjs',
      'apiwrappers/reg-mangaupdates/api-wrapper-mangaupdates.cjs',
      'apiwrappers/reg-mangaupdates/mangaupdates-api-settings.json',
      'apiwrappers/reg-mangaupdates/mapper-mangaupdates.cjs',
      'apiwrappers/reg-mangaupdates/tracker-module.cjs',
      'apiwrappers/trackerdtocontract.cjs',
      'tracker-package.json',
    ]);

    const manifestFile = zip.file('tracker-package.json');
    assert.ok(manifestFile);
    const manifestRaw = await manifestFile.async('string');
    const manifest = JSON.parse(manifestRaw);

    assert.equal(manifest.serviceName, 'mangaupdates');
    assert.equal(manifest.hostApiVersion, '1.2.3');
    assert.equal(manifest.entrypoints.trackerModule, 'apiwrappers/reg-mangaupdates/tracker-module.cjs');
    assert.equal(manifest.entrypoints.mapperModule, 'apiwrappers/reg-mangaupdates/mapper-mangaupdates.cjs');
    assert.equal(manifest.entrypoints.settingsFile, 'apiwrappers/reg-mangaupdates/mangaupdates-api-settings.json');

    const settingsFile = zip.file('apiwrappers/reg-mangaupdates/mangaupdates-api-settings.json');
    // This file is generated at package build time from definition + values sources.
    assert.ok(settingsFile);
  assert.equal(zip.file('apiwrappers/reg-mangaupdates/mangaupdates-api-settings.definition.json'), null);
  assert.equal(zip.file('apiwrappers/reg-mangaupdates/mangaupdates-api-settings.values.json'), null);
    const settingsRaw = await settingsFile.async('string');
    const effectiveSettings = JSON.parse(settingsRaw);
    assert.equal(effectiveSettings.metadata.componentName, 'MangaUpdatesAPI');
    assert.equal(effectiveSettings.settings['api.endpoints.listUpdateSeries.template'], '${baseUrl}/lists/series/update');
    assert.equal(effectiveSettings.settings['api.endpoints.seriesSearch.template'], '${baseUrl}/series/search');
    assert.equal(effectiveSettings.settings['api.endpoints.seriesImage.template'], '${baseUrl}/series/${series_id}/image');
    assert.equal(effectiveSettings.settings['rateLimit.perEndpoint.seriesSearch'], 1500);
    assert.equal(effectiveSettings.settings['rateLimit.perEndpoint.seriesImage'], 1000);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
