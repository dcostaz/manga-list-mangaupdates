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
 * watch.summary -> summarizeEntries(). Array in, array out, per-entry failure
 * (host-capability-contract.md §2.1), reusing getReadingList() -- there is no bulk-by-id lookup
 * endpoint here the way MangaDex's getMangaByIds() is, so the whole list is fetched once and
 * filtered to the requested ids. Stubs getReadingList() directly, same approach
 * runtime-wrapper-querylive.test.cjs already uses for queryLive's own getSeriesById/getSeriesUrl.
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

test('summarizeEntries: array in, array out, in request order', async () => {
  const wrapper = await createWrapper();
  wrapper.getReadingList = async () => [
    { pluginEntryId: 'id-1', status: 'READING' },
    { pluginEntryId: 'id-2', status: 'PLAN_TO_READ' },
  ];

  const out = await wrapper.summarizeEntries(['id-1', 'id-2']);
  assert.ok(Array.isArray(out), 'array out, not a map (host-capability-contract.md §2.1)');
  assert.deepEqual(out.map((r) => r.pluginEntryId), ['id-1', 'id-2']);
  assert.equal(out[0].success, true);
  assert.equal(out[0].summary.linkState, 'active');
  assert.equal(out[0].summary.label, 'Reading');
  assert.equal(out[1].summary.label, 'Plan to read');
});

test('summarizeEntries: an id absent from the reading list is an explicit answer (success:true, linkState error)', async () => {
  const wrapper = await createWrapper();
  wrapper.getReadingList = async () => []; // not on any list -- removed, or never added

  const out = await wrapper.summarizeEntries(['gone-id']);
  assert.equal(out.length, 1);
  assert.equal(out[0].pluginEntryId, 'gone-id');
  assert.equal(out[0].success, true, 'the plugin answered -- the entry just is not on any list');
  assert.equal(out[0].summary.linkState, 'error');
  assert.match(out[0].summary.label, /gone-id/);
});

test('summarizeEntries: a thrown getReadingList degrades to per-entry success:false, never a whole-batch throw', async () => {
  const wrapper = await createWrapper();
  wrapper.getReadingList = async () => { throw new Error('network down'); };

  const out = await wrapper.summarizeEntries(['id-1', 'id-2']);
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.success === false));
  assert.ok(out.every((r) => typeof r.error === 'string' && r.error.includes('network down')));
});

test('summarizeEntries: an empty request is an empty array, never a throw', async () => {
  const wrapper = await createWrapper();
  assert.deepEqual(await wrapper.summarizeEntries([]), []);
  assert.deepEqual(await wrapper.summarizeEntries(undefined), []);
});
