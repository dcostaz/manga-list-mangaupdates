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
 * summarizeEntries() reuses the reading list it fetched for a minute. MangaUpdates has no lookup by id, so
 * each answer costs the whole list; the host asks once per batch of cards it shows, and the list was being
 * fetched again for every batch (the host's reads waited on it, up to its 5 s timeout, and gave up).
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

/** A wrapper whose getReadingList() counts its calls and answers with the given list. */
async function wrapperWithList(list) {
  const wrapper = await createWrapper();
  const calls = { count: 0 };
  wrapper.getReadingList = async () => {
    calls.count += 1;
    return list;
  };
  return { wrapper, calls };
}

test('summarizeEntries: a second batch within the minute reuses the list, not a second fetch', async () => {
  const { wrapper, calls } = await wrapperWithList([{ pluginEntryId: 'id-1', status: 'READING' }, { pluginEntryId: 'id-2', status: 'COMPLETE' }]);

  const first = await wrapper.summarizeEntries(['id-1']);
  const second = await wrapper.summarizeEntries(['id-2']);

  assert.equal(calls.count, 1, 'the whole list is fetched once for both batches');
  assert.equal(first[0].summary.label, 'Reading');
  assert.equal(second[0].summary.label, 'Complete');
});

test('summarizeEntries: calls that overlap share one fetch', async () => {
  const wrapper = await createWrapper();
  let count = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  wrapper.getReadingList = async () => {
    count += 1;
    await gate;
    return [{ pluginEntryId: 'id-1', status: 'READING' }];
  };

  const pending = [wrapper.summarizeEntries(['id-1']), wrapper.summarizeEntries(['id-1']), wrapper.summarizeEntries(['id-1'])];
  release();
  const answers = await Promise.all(pending);

  assert.equal(count, 1);
  assert.ok(answers.every((out) => out[0].summary.label === 'Reading'));
});

test('summarizeEntries: after the minute the list is fetched again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { wrapper, calls } = await wrapperWithList([{ pluginEntryId: 'id-1', status: 'READING' }]);

  await wrapper.summarizeEntries(['id-1']);
  t.mock.timers.setTime(1_000_000 + 59_000);
  await wrapper.summarizeEntries(['id-1']);
  assert.equal(calls.count, 1, 'still fresh at 59 s');

  t.mock.timers.setTime(1_000_000 + 61_000);
  await wrapper.summarizeEntries(['id-1']);
  assert.equal(calls.count, 2, 'fetched again after a minute');
});

test('summarizeEntries: a failed fetch is not kept, so the next call tries again', async () => {
  const wrapper = await createWrapper();
  let count = 0;
  wrapper.getReadingList = async () => {
    count += 1;
    if (count === 1) throw new Error('network down');
    return [{ pluginEntryId: 'id-1', status: 'READING' }];
  };

  const failed = await wrapper.summarizeEntries(['id-1']);
  assert.equal(failed[0].success, false);

  const retried = await wrapper.summarizeEntries(['id-1']);
  assert.equal(count, 2, 'the failure was not cached');
  assert.equal(retried[0].success, true);
  assert.equal(retried[0].summary.label, 'Reading');
});

test('summarizeEntries: another sign-in never reuses the list fetched under the previous one', async () => {
  const { wrapper, calls } = await wrapperWithList([{ pluginEntryId: 'id-1', status: 'READING' }]);
  wrapper.bearerToken = 'token-a';

  await wrapper.summarizeEntries(['id-1']);
  wrapper.bearerToken = 'token-b';
  await wrapper.summarizeEntries(['id-1']);

  assert.equal(calls.count, 2);
});

test('getReadingList itself is not cached: a sync that asks for the list always gets a fresh one', async () => {
  const wrapper = await createWrapper();
  const original = wrapper.getReadingList.bind(wrapper);
  let userListsCalls = 0;
  wrapper.getUserLists = async () => { userListsCalls += 1; return []; };

  await original();
  await original();

  assert.equal(userListsCalls, 2);
});
