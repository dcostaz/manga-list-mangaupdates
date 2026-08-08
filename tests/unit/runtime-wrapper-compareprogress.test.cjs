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

async function createWrapper() {
  return MangaUpdatesAPIWrapper.init({
    serviceSettings: {
      'api.baseUrl': 'https://api.mangaupdates.com/v1',
      'api.endpoints.login.template': '${baseUrl}/account/login',
    },
  });
}

test('compareProgress: chapterAhead compares on the integer part only (MangaUpdates reading-list chapter is integer-only, owner correction 2026-07-23)', async () => {
  const wrapper = await createWrapper();

  // Host has a fractional chapter (e.g. a half/extra chapter, 45.5); the
  // remote (already an integer per MangaUpdates' real API contract) is 45 —
  // must NOT report "ahead" or "behind" from the fractional part alone.
  const result = wrapper.compareProgress({ chapter: 45.5 }, { chapter: 45 });
  assert.equal(result.chapterAhead, false);
  assert.equal(result.chapterBehindOrEqual, true);
});

test('compareProgress: chapterAhead is true when the remote integer part genuinely exceeds the host', async () => {
  const wrapper = await createWrapper();
  const result = wrapper.compareProgress({ chapter: 45.5 }, { chapter: 46 });
  assert.equal(result.chapterAhead, true);
  assert.equal(result.chapterBehindOrEqual, false);
});

test('compareProgress: equal integer parts report behindOrEqual, never ahead (R2 no-op case)', async () => {
  const wrapper = await createWrapper();
  const result = wrapper.compareProgress({ chapter: 45.9 }, { chapter: 45 });
  assert.equal(result.chapterAhead, false);
  assert.equal(result.chapterBehindOrEqual, true);
});

test('compareProgress: chapter fields return null (not false) when either side is missing', async () => {
  const wrapper = await createWrapper();
  assert.deepEqual(
    { chapterAhead: null, chapterBehindOrEqual: null },
    (({ chapterAhead, chapterBehindOrEqual }) => ({ chapterAhead, chapterBehindOrEqual }))(
      wrapper.compareProgress({ chapter: null }, { chapter: 45 }),
    ),
  );
  assert.deepEqual(
    { chapterAhead: null, chapterBehindOrEqual: null },
    (({ chapterAhead, chapterBehindOrEqual }) => ({ chapterAhead, chapterBehindOrEqual }))(
      wrapper.compareProgress({ chapter: 45 }, {}),
    ),
  );
});

test('compareProgress: ratingDiffers is a direct comparison (MangaUpdates rating is float-capable, no rounding needed)', async () => {
  const wrapper = await createWrapper();
  assert.equal(wrapper.compareProgress({ rating: 8 }, { rating: 8 }).ratingDiffers, false);
  assert.equal(wrapper.compareProgress({ rating: 8 }, { rating: 9 }).ratingDiffers, true);
  assert.equal(wrapper.compareProgress({ rating: 8.5 }, { rating: 8.5 }).ratingDiffers, false);
  assert.equal(wrapper.compareProgress({ rating: null }, { rating: null }).ratingDiffers, null);
});

test('compareProgress: statusDiffers compares .status directly', async () => {
  const wrapper = await createWrapper();
  assert.equal(wrapper.compareProgress({ status: 'READING' }, { status: 'READING' }).statusDiffers, false);
  assert.equal(wrapper.compareProgress({ status: 'READING' }, { status: 'COMPLETED' }).statusDiffers, true);
  assert.equal(wrapper.compareProgress({}, {}).statusDiffers, null);
});
