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
 * Plan-2026Q3-property-modal-delete-actions, Phase 9, Step 9.4: queryLive
 * coverage for MangaUpdates. queryLive is a thin wrapper around the existing
 * getSeriesById(id, useCache=false) + getSeriesUrl(id) calls, so these tests
 * stub those two methods directly rather than mocking the HTTP layer again.
 */

async function createWrapper() {
  return MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
    },
    httpClient: {
      interceptors: { response: { use: () => 0 } },
      get: async () => ({ data: [] }),
      post: async () => ({ data: {} }),
      put: async () => ({ data: { context: { session_token: 'x' } } }),
    },
    context: { cache: { getValue: async () => null, setValue: async () => {} }, utils: null },
  });
}

test('queryLive: status ok when getSeriesById resolves a series', async () => {
  const wrapper = await createWrapper();
  wrapper.getSeriesById = async (id, useCache) => {
    assert.equal(useCache, false, 'queryLive must bypass the cache');
    return {
      title: 'Dandadan',
      alternativeTitles: ['Dan Da Dan'],
      metadata: { status: 'Ongoing', type: 'Manga', year: 2021 },
    };
  };
  wrapper.getSeriesUrl = async () => 'https://www.mangaupdates.com/series/7';

  const result = await wrapper.queryLive('7');
  assert.equal(result.status, 'ok');
  assert.equal(result.data.pluginEntryId, '7');
  assert.equal(result.data.displayTitle, 'Dandadan');
  assert.equal(result.data.linkState, 'active');
  assert.equal(typeof result.data.fetchedAt, 'string');
  const statGrid = result.data.sections.find((s) => s.type === 'stat-grid');
  assert.ok(statGrid, 'expected a stat-grid section');
  assert.equal(statGrid.fields['Series status'], 'Ongoing');
  const linkList = result.data.sections.find((s) => s.type === 'link-list');
  assert.ok(linkList, 'expected a link-list section when getSeriesUrl succeeds');
  assert.equal(linkList.links[0].url, 'https://www.mangaupdates.com/series/7');
});

test('queryLive: status not_found when getSeriesById resolves null', async () => {
  const wrapper = await createWrapper();
  wrapper.getSeriesById = async () => null;

  const result = await wrapper.queryLive('999999');
  assert.deepEqual(result, { status: 'not_found' });
});

test('queryLive: status error (retryable) when getSeriesById throws', async () => {
  const wrapper = await createWrapper();
  wrapper.getSeriesById = async () => { throw new Error('network unreachable'); };

  const result = await wrapper.queryLive('7');
  assert.equal(result.status, 'error');
  assert.equal(result.message, 'network unreachable');
  assert.equal(result.retryable, true);
});

test('queryLive: tolerates getSeriesUrl failure without failing the whole call', async () => {
  const wrapper = await createWrapper();
  wrapper.getSeriesById = async () => ({ title: 'Dandadan', metadata: {} });
  wrapper.getSeriesUrl = async () => { throw new Error('url resolution failed'); };

  const result = await wrapper.queryLive('7');
  assert.equal(result.status, 'ok');
  assert.equal(result.data.sections.some((s) => s.type === 'link-list'), false);
});
