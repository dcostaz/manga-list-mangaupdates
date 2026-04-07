'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const MangaUpdatesTrackerMapper = require(path.join(
  __dirname,
  '..',
  'src',
  'runtime',
  'apiwrappers',
  'reg-mangaupdates',
  'mapper-mangaupdates.cjs',
));
const {
  TRACKER_DTO_CONTRACT_VERSION,
} = require(path.join(
  __dirname,
  '..',
  'src',
  'runtime',
  'apiwrappers',
  'trackerdtocontract.cjs',
));

test('wave0 mapper contract - mapper identity and contract version are stable', () => {
  const mapper = new MangaUpdatesTrackerMapper({ source: 'test' });
  assert.equal(mapper.trackerId, 'mangaupdates');
  assert.equal(mapper.dtoContractVersion, TRACKER_DTO_CONTRACT_VERSION);
});

test('wave0 mapper contract - toSearchResultDtos maps valid rows and drops invalid rows', () => {
  const mapper = new MangaUpdatesTrackerMapper();
  const dtoList = mapper.toSearchResultDtos({
    payload: {
      data: [
        { id: 'mu-123', title: 'A' },
        { id: 'mu-missing-title', title: null },
        { id: null, title: 'No Id' },
      ],
    },
  });

  assert.equal(dtoList.length, 1);
  assert.deepEqual(dtoList[0], {
    source: 'mangaupdates',
    trackerId: 'mu-123',
    title: 'A',
    alternativeTitles: [],
    coverUrl: null,
    metadata: null,
    confidence: 0,
    matchType: 'exact',
  });
});

test('wave0 mapper contract - toSeriesDetailDto returns null on invalid payload', () => {
  const mapper = new MangaUpdatesTrackerMapper();
  assert.equal(mapper.toSeriesDetailDto(null), null);
  assert.equal(mapper.toSeriesDetailDto({ payload: { id: 'mu-1' } }), null);
});

test('wave0 mapper contract - toSeriesDetailDto maps required fields', () => {
  const mapper = new MangaUpdatesTrackerMapper();
  const dto = mapper.toSeriesDetailDto({
    payload: {
      id: 'mu-1',
      title: 'Dandadan',
    },
  });

  assert.deepEqual(dto, {
    trackerId: 'mu-1',
    source: 'mangaupdates',
    title: 'Dandadan',
    alternativeTitles: [],
    description: null,
    status: null,
    year: null,
    url: null,
    metadata: null,
  });
});

test('wave0 mapper contract - toStatusDto normalizes numeric fields and optional status', () => {
  const mapper = new MangaUpdatesTrackerMapper();
  const dto = mapper.toStatusDto({
    payload: {
      status: 'reading',
      chapter: 102,
      volume: 'n/a',
      rating: 8,
    },
  });

  assert.deepEqual(dto, {
    status: 'reading',
    chapter: 102,
    volume: null,
    rating: 8,
    lastUpdated: null,
  });
});

test('wave0 mapper contract - toCoverMetadataDtos returns empty collection for placeholder mapper', () => {
  const mapper = new MangaUpdatesTrackerMapper();
  assert.deepEqual(mapper.toCoverMetadataDtos({ payload: [] }), []);
});