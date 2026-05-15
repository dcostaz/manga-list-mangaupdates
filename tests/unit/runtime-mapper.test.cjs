'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const MangaUpdatesTrackerMapper = require(path.join(
  __dirname,
  '..',
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
    confidence: 100,
    matchType: 'exact',
  });
});

test('wave0 mapper contract - toSearchResultDtos accepts enriched rows with record fallback fields', () => {
  const mapper = new MangaUpdatesTrackerMapper();
  const dtoList = mapper.toSearchResultDtos({
    payload: {
      data: [
        {
          id: 654,
          hit_title: 'The Beginning After the End',
          matchType: 'fuzzy',
          confidence: 87,
          metadata: { matchedTitle: 'TBATE' },
          record: {
            title: 'The Beginning After the End',
            associated: [{ title: 'TBATE' }],
            image: {
              url: {
                thumb: 'https://img.example/tbate-thumb.jpg',
              },
            },
          },
        },
      ],
    },
  });

  assert.equal(dtoList.length, 1);
  assert.deepEqual(dtoList[0], {
    source: 'mangaupdates',
    trackerId: '654',
    title: 'The Beginning After the End',
    alternativeTitles: ['TBATE'],
    coverUrl: 'https://img.example/tbate-thumb.jpg',
    metadata: { matchedTitle: 'TBATE' },
    confidence: 87,
    matchType: 'fuzzy',
  });
});

test('wave0 mapper contract - toSearchResultDtos backfills metadata year/type from record when metadata is sparse', () => {
  const mapper = new MangaUpdatesTrackerMapper();
  const dtoList = mapper.toSearchResultDtos({
    payload: {
      data: [
        {
          id: 901,
          hit_title: 'Omniscient Reader\'s Viewpoint',
          metadata: {
            matchedTitle: 'ORV',
            year: null,
            type: null,
          },
          record: {
            title: 'Omniscient Reader\'s Viewpoint',
            year_released: '2020',
            type: 'Manhwa',
          },
        },
      ],
    },
  });

  assert.equal(dtoList.length, 1);
  assert.deepEqual(dtoList[0], {
    source: 'mangaupdates',
    trackerId: '901',
    title: 'Omniscient Reader\'s Viewpoint',
    alternativeTitles: [],
    coverUrl: null,
    metadata: {
      matchedTitle: 'ORV',
      year: 2020,
      type: 'Manhwa',
    },
    confidence: 100,
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
    genres: [],
    authors: [],
    publishers: [],
    url: null,
    cover: null,
    metadata: null,
  });
});

test('wave0 mapper contract - toSeriesDetailDto maps enriched nested series payload', () => {
  const mapper = new MangaUpdatesTrackerMapper();
  const dto = mapper.toSeriesDetailDto({
    payload: {
      id: 777,
      title: 'Tower of God',
      url: 'https://www.mangaupdates.com/series/tower-of-god',
      series: {
        series_id: 777,
        title: 'Tower of God',
        associated: [{ title: 'Sin-ui Tap' }],
        genres: [{ genre: 'Action' }, { genre: 'Fantasy' }],
        authors: [{ name: 'SIU', type: 'story' }],
        publishers: [{ publisher_name: 'Naver', type: 'original' }],
        description: 'A long-running webtoon.',
        status: 'Ongoing',
        year: 2010,
        image: {
          url: {
            original: 'https://cdn.mangaupdates.com/image/i509035.jpg',
            thumb: 'https://cdn.mangaupdates.com/image/i509035.thumb.jpg',
          },
        },
      },
    },
  });

  assert.deepEqual(dto, {
    trackerId: '777',
    source: 'mangaupdates',
    title: 'Tower of God',
    alternativeTitles: ['Sin-ui Tap'],
    description: 'A long-running webtoon.',
    status: 'Ongoing',
    year: 2010,
    genres: ['Action', 'Fantasy'],
    authors: [{ name: 'SIU', type: 'story' }],
    publishers: [{ name: 'Naver', type: 'original' }],
    url: 'https://www.mangaupdates.com/series/tower-of-god',
    cover: {
      trackerId: '777',
      source: 'mangaupdates',
      coverUrl: 'https://cdn.mangaupdates.com/image/i509035.jpg',
      thumbnailUrl: 'https://cdn.mangaupdates.com/image/i509035.thumb.jpg',
      fileName: null,
      mimeType: null,
      width: null,
      height: null,
    },
    metadata: {
      series_id: 777,
      title: 'Tower of God',
      associated: [{ title: 'Sin-ui Tap' }],
      genres: [{ genre: 'Action' }, { genre: 'Fantasy' }],
      authors: [{ name: 'SIU', type: 'story' }],
      publishers: [{ publisher_name: 'Naver', type: 'original' }],
      description: 'A long-running webtoon.',
      status: 'Ongoing',
      year: 2010,
      image: {
        url: {
          original: 'https://cdn.mangaupdates.com/image/i509035.jpg',
          thumb: 'https://cdn.mangaupdates.com/image/i509035.thumb.jpg',
        },
      },
    },
  });
});

test('wave0 mapper contract - toSeriesDetailDto canonicalizes publisher role alias to Original', () => {
  const mapper = new MangaUpdatesTrackerMapper();
  const dto = mapper.toSeriesDetailDto({
    payload: {
      id: 778,
      title: 'Alias Publisher Series',
      publishers: [{ publisher_name: 'Naver', type: 'Publisher' }],
      series: {
        series_id: 778,
        title: 'Alias Publisher Series',
        publishers: [
          { publisher_name: 'Naver', type: 'original' },
          { publisher_name: 'Line Webtoon', role: 'publisher' }
        ]
      }
    }
  });

  assert.deepEqual(dto && dto.publishers, [
    { name: 'Naver', type: 'Original' },
    { name: 'Line Webtoon', type: 'Original' }
  ]);
});

test('wave0 mapper contract - toSeriesDetailDto resolves year from alternate series year keys', () => {
  const mapper = new MangaUpdatesTrackerMapper();
  const dto = mapper.toSeriesDetailDto({
    payload: {
      id: 9001,
      title: 'Fallback Year Series',
      series: {
        series_id: 9001,
        title: 'Fallback Year Series',
        year: '',
        year_released: '2019',
      },
    },
  });

  assert.equal(dto && dto.year, 2019);
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

test('wave0 mapper contract - toCoverMetadataDtos maps cover metadata from series payload', () => {
  const mapper = new MangaUpdatesTrackerMapper();
  assert.deepEqual(mapper.toCoverMetadataDtos({
    payload: {
      id: 777,
      series: {
        image: {
          url: {
            original: 'https://cdn.mangaupdates.com/image/i509035.jpg',
            thumb: 'https://cdn.mangaupdates.com/image/i509035.thumb.jpg',
          },
        },
      },
    },
  }), [{
    trackerId: '777',
    source: 'mangaupdates',
    coverUrl: 'https://cdn.mangaupdates.com/image/i509035.jpg',
    thumbnailUrl: 'https://cdn.mangaupdates.com/image/i509035.thumb.jpg',
    fileName: null,
    mimeType: null,
    width: null,
    height: null,
  }]);
});