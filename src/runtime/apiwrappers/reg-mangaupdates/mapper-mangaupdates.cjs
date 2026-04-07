'use strict';

const path = require('path');
const { TRACKER_DTO_CONTRACT_VERSION } = require(path.join(__dirname, '..', 'trackerdtocontract.cjs'));

/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesRawSearchResponse} MangaUpdatesRawSearchResponse */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesRawEntityResponse} MangaUpdatesRawEntityResponse */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesSeriesDetailDto} MangaUpdatesSeriesDetailDto */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesStatusDto} MangaUpdatesStatusDto */

class MangaUpdatesTrackerMapper {
  /**
   * @param {Record<string, unknown> | null} [initContext]
   */
  constructor(initContext = null) {
    this.trackerId = 'mangaupdates';
    this.dtoContractVersion = TRACKER_DTO_CONTRACT_VERSION;
    this.initContext = initContext;
  }

  /**
    * @param {MangaUpdatesRawSearchResponse | null} raw
   * @returns {Array<Record<string, unknown>>}
   */
  toSearchResultDtos(raw) {
    const payload = raw && typeof raw === 'object' ? raw.payload : null;
    const rows = payload && Array.isArray(payload.data) ? payload.data : [];

    return rows
      .map((row) => {
        const directId = row && (typeof row.id === 'string' || typeof row.id === 'number')
          ? String(row.id)
          : null;
        const record = row && typeof row.record === 'object' ? row.record : null;
        const recordId = record && (typeof record.series_id === 'string' || typeof record.series_id === 'number')
          ? String(record.series_id)
          : null;
        const trackerId = directId || recordId;

        const title = row && typeof row.title === 'string'
          ? row.title
          : row && typeof row.hit_title === 'string'
            ? row.hit_title
            : record && typeof record.title === 'string'
              ? record.title
              : null;

        if (!trackerId || !title) {
          return null;
        }

        const associated = record && Array.isArray(record.associated)
          ? record.associated
          : [];
        const alternativeTitles = associated
          .map((entry) => (entry && typeof entry === 'object' && typeof entry.title === 'string' ? entry.title : null))
          .filter((entry) => entry !== null);

        const image = record && record.image && typeof record.image === 'object'
          ? record.image
          : null;
        const imageUrl = image && image.url && typeof image.url === 'object' ? image.url : null;
        const coverUrl = row && typeof row.coverUrl === 'string'
          ? row.coverUrl
          : imageUrl && typeof imageUrl.original === 'string'
            ? imageUrl.original
            : imageUrl && typeof imageUrl.thumb === 'string'
              ? imageUrl.thumb
              : null;

        const matchType = row && typeof row.matchType === 'string' && ['exact', 'fuzzy', 'manual'].includes(row.matchType)
          ? row.matchType
          : 'exact';
        const confidence = row && typeof row.confidence === 'number'
          ? row.confidence
          : matchType === 'exact'
            ? 100
            : matchType === 'fuzzy'
              ? 80
              : 0;

        return {
          source: this.trackerId,
          trackerId,
          title,
          alternativeTitles,
          coverUrl,
          metadata: row && row.metadata && typeof row.metadata === 'object' ? row.metadata : null,
          confidence,
          matchType,
        };
      })
      .filter((entry) => entry !== null);
  }

  /**
    * @param {MangaUpdatesRawEntityResponse | null} raw
    * @returns {MangaUpdatesSeriesDetailDto | null}
   */
  toSeriesDetailDto(raw) {
    const payload = raw && typeof raw === 'object' ? raw.payload : null;
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const series = payload.series && typeof payload.series === 'object' ? payload.series : null;
    const payloadId = typeof payload.id === 'string' || typeof payload.id === 'number'
      ? String(payload.id)
      : null;
    const seriesId = series && (typeof series.series_id === 'string' || typeof series.series_id === 'number')
      ? String(series.series_id)
      : series && (typeof series.id === 'string' || typeof series.id === 'number')
        ? String(series.id)
        : null;
    const trackerId = payloadId || seriesId;

    const title = typeof payload.title === 'string'
      ? payload.title
      : series && typeof series.title === 'string'
        ? series.title
        : null;

    if (!trackerId || !title) {
      return null;
    }

    const associated = series && Array.isArray(series.associated)
      ? series.associated
      : [];
    const alternativeTitles = associated
      .map((entry) => (entry && typeof entry === 'object' && typeof entry.title === 'string' ? entry.title : null))
      .filter((entry) => entry !== null);

    const payloadYear = typeof payload.year === 'number'
      ? payload.year
      : typeof payload.year === 'string'
        ? Number(payload.year)
        : null;
    const seriesYear = series && typeof series.year === 'number'
      ? series.year
      : series && typeof series.year === 'string'
        ? Number(series.year)
        : null;
    const normalizedYear = Number.isFinite(payloadYear) && payloadYear !== null
      ? payloadYear
      : Number.isFinite(seriesYear) && seriesYear !== null
        ? seriesYear
        : null;

    return {
      trackerId,
      source: this.trackerId,
      title,
      alternativeTitles,
      description: typeof payload.description === 'string'
        ? payload.description
        : series && typeof series.description === 'string'
          ? series.description
          : null,
      status: typeof payload.status === 'string'
        ? payload.status
        : series && typeof series.status === 'string'
          ? series.status
          : null,
      year: normalizedYear,
      url: typeof payload.url === 'string'
        ? payload.url
        : series && typeof series.url === 'string'
          ? series.url
          : null,
      metadata: series || null,
    };
  }

  /**
    * @param {MangaUpdatesRawEntityResponse | null} raw
    * @returns {MangaUpdatesStatusDto | null}
   */
  toStatusDto(raw) {
    const payload = raw && typeof raw === 'object' ? raw.payload : null;
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    return {
      status: typeof payload.status === 'string' ? payload.status : undefined,
      chapter: typeof payload.chapter === 'number' ? payload.chapter : null,
      volume: typeof payload.volume === 'number' ? payload.volume : null,
      rating: typeof payload.rating === 'number' ? payload.rating : null,
      lastUpdated: null,
    };
  }

  /**
   * @param {unknown} _raw
   * @returns {Array<Record<string, unknown>>}
   */
  toCoverMetadataDtos(_raw) {
    return [];
  }
}

module.exports = MangaUpdatesTrackerMapper;
