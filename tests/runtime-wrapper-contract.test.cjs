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
const MangaUpdatesAPISettings = require(path.join(
  __dirname,
  '..',
  'src',
  'runtime',
  'apiwrappers',
  'reg-mangaupdates',
  'api-settings-mangaupdates.cjs',
));

test('wave0 wrapper contract - init preserves instance and settings payload', async () => {
  const apiSettings = await MangaUpdatesAPISettings.init({
    defaultSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
    },
  });

  const wrapper = await MangaUpdatesAPIWrapper.init({
    apiSettings,
    serviceSettings: {
      featureFlags: {
        search: true,
      },
    },
  });

  assert.ok(wrapper instanceof MangaUpdatesAPIWrapper);
  assert.equal(wrapper.apiSettings, apiSettings);
  assert.deepEqual(wrapper.settings, {
    featureFlags: {
      search: true,
    },
  });
});

test('wave0 wrapper contract - init normalizes invalid option shapes', async () => {
  const wrapper = await MangaUpdatesAPIWrapper.init({
    apiSettings: { not: 'an-instance' },
    serviceSettings: 'invalid-shape',
  });

  assert.equal(wrapper.apiSettings, null);
  assert.deepEqual(wrapper.settings, {});
});

test('wave0 wrapper contract - searchTrackersRaw returns normalized payload', async () => {
  const wrapper = await MangaUpdatesAPIWrapper.init();
  const raw = await wrapper.searchTrackersRaw('  Solo Leveling  ');

  assert.equal(raw.trackerId, 'mangaupdates');
  assert.equal(raw.operation, 'searchTrackersRaw');
  assert.equal(Array.isArray(raw.payload.data), true);
  assert.equal(raw.payload.data.length, 1);
  assert.deepEqual(raw.payload.data[0], {
    id: 'mu-solo leveling',
    title: 'Solo Leveling',
  });
});

test('wave0 wrapper contract - raw entity methods provide fallback-safe payloads', async () => {
  const wrapper = await MangaUpdatesAPIWrapper.init();

  const seriesRaw = await wrapper.getSeriesByIdRaw('  ');
  assert.equal(seriesRaw.operation, 'getSeriesByIdRaw');
  assert.equal(seriesRaw.payload.id, 'unknown');
  assert.equal(seriesRaw.payload.title, 'Unknown MangaUpdates Title');

  const progressRaw = await wrapper.getUserProgressRaw(null);
  assert.equal(progressRaw.operation, 'getUserProgressRaw');
  assert.equal(progressRaw.payload.trackerId, null);
  assert.equal(progressRaw.payload.status, 'reading');
  assert.equal(progressRaw.payload.chapter, 0);
  assert.equal(progressRaw.payload.volume, null);
});

test('wave0 wrapper contract - serviceName remains runtime module stable', () => {
  assert.equal(MangaUpdatesAPIWrapper.serviceName, 'mangaupdates');
});