'use strict';

const path = require('path');
const { TRACKER_DTO_CONTRACT_VERSION } = require(path.join(__dirname, '..', 'trackerdtocontract.cjs'));

/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesRawSearchResponse} MangaUpdatesRawSearchResponse */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesRawEntityResponse} MangaUpdatesRawEntityResponse */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesSeriesDetailDto} MangaUpdatesSeriesDetailDto */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesStatusDto} MangaUpdatesStatusDto */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesCoverMetadataDto} MangaUpdatesCoverMetadataDto */

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
        const alternativeTitles = this._normalizeAlternativeTitles(associated);

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

        const rowMetadata = row && row.metadata && typeof row.metadata === 'object'
          ? { ...row.metadata }
          : {};

        const recordYear = this._resolveYear(
          record && record.year,
          record && record.year_released,
          record && record.release_year,
          record && record.releaseYear,
          record && record.start_year,
          record && record.startYear,
        );
        const metadataYear = this._resolveYear(rowMetadata.year);
        if (metadataYear === null && recordYear !== null) {
          rowMetadata.year = recordYear;
        }

        const recordType = this._normalizeString(
          record && record.type,
          record && record.seriesType,
          record && record.series_type,
          record && record.publicationType,
          record && record.publication_type,
        );
        const metadataType = this._normalizeString(rowMetadata.type);
        if (!metadataType && recordType) {
          rowMetadata.type = recordType;
        }
        const wrapperEvidence = this._buildWrapperEvidence(row, rowMetadata, title, alternativeTitles);

        return {
          source: this.trackerId,
          trackerId,
          title,
          alternativeTitles,
          coverUrl,
          metadata: Object.keys(rowMetadata).length > 0 ? rowMetadata : null,
          wrapperEvidence,
        };
      })
      .filter((entry) => entry !== null);
  }

  /**
   * @param {Record<string, unknown>} row
   * @param {Record<string, unknown>} rowMetadata
   * @param {string} title
   * @param {string[]} alternativeTitles
   * @returns {Record<string, unknown>}
   */
  _buildWrapperEvidence(row, rowMetadata, title, alternativeTitles) {
    const rawMatchType = typeof row.matchType === 'string' ? row.matchType.trim().toLowerCase() : '';
    const rawMatchedTitle = this._normalizeString(
      row.hit_title,
      row.matchedTitle,
      rowMetadata.matchedTitle,
      title
    );
    const normalizedTitle = typeof title === 'string' ? title.trim().toLowerCase() : '';
    const normalizedMatchedTitle = typeof rawMatchedTitle === 'string' ? rawMatchedTitle.trim().toLowerCase() : '';

    let classification = 'weak';
    if (rawMatchType === 'exact') {
      classification = 'exact';
      const hasAliasExact = Boolean(
        normalizedMatchedTitle
        && normalizedTitle
        && normalizedMatchedTitle !== normalizedTitle
        && alternativeTitles.some((entry) => typeof entry === 'string' && entry.trim().toLowerCase() === normalizedMatchedTitle)
      );
      if (hasAliasExact) {
        classification = 'alias-exact';
      }
    } else if (rawMatchType === 'fuzzy') {
      classification = 'fuzzy';
    }

    const rawMatchedField = this._normalizeString(
      row.matchedField,
      rowMetadata.matchedField
    );
    const matchedField = rawMatchedField === 'title'
      ? 'title'
      : rawMatchedField === 'alternativeTitles'
        ? 'alternativeTitles'
        : rawMatchedField === 'metadata'
          ? 'metadata'
          : normalizedMatchedTitle && normalizedMatchedTitle !== normalizedTitle
            ? 'alternativeTitles'
            : 'title';

    const similarity = this._normalizeUnitInterval(
      row.similarity,
      rowMetadata.similarity
    );
    const tokenOverlap = this._normalizeUnitInterval(
      row.tokenOverlap,
      rowMetadata.tokenOverlap
    );
    const wrapperScore = this._normalizeUnitInterval(
      row.wrapperScore,
      rowMetadata.wrapperScore,
      row.confidence,
      rowMetadata.confidence
    );

    return {
      classification,
      matchedField,
      matchedText: rawMatchedTitle,
      similarity,
      tokenOverlap,
      wrapperScore,
      algorithmVersion: 'mangaupdates-search-v2',
    };
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
    const alternativeTitles = this._normalizeAlternativeTitles(associated);

    const payloadMetadata = payload.metadata && typeof payload.metadata === 'object'
      ? payload.metadata
      : null;
    const seriesMetadata = series && series.metadata && typeof series.metadata === 'object'
      ? series.metadata
      : null;
    const normalizedYear = this._resolveYear(
      payload.year,
      series && series.year,
      series && series.year_released,
      series && series.release_year,
      series && series.releaseYear,
      series && series.start_year,
      series && series.startYear,
      payloadMetadata && payloadMetadata.year,
      seriesMetadata && seriesMetadata.year,
    );

    const normalizedGenres = this._normalizeMetadataStringArray(
      [
        payload.genres,
        series && series.genres,
      ],
      ['genre', 'name', 'label', 'title', 'value']
    );
    const normalizedAuthors = this._normalizeContributorEntries(
      [
        payload.authors,
        series && series.authors,
      ],
      ['name', 'author', 'fullName', 'label', 'title'],
      'Unknown'
    );
    const normalizedPublishers = this._normalizeContributorEntries(
      [
        payload.publishers,
        series && series.publishers,
      ],
      ['publisher_name', 'publisherName', 'name', 'publisher', 'label', 'title'],
      'Unknown'
    );

    const cover = this._extractCoverMetadataDto(trackerId, payload, series);

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
      genres: normalizedGenres,
      authors: normalizedAuthors,
      publishers: normalizedPublishers,
      url: typeof payload.url === 'string'
        ? payload.url
        : series && typeof series.url === 'string'
          ? series.url
          : null,
      cover,
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
   * @param {MangaUpdatesRawEntityResponse | null} raw
   * @returns {MangaUpdatesCoverMetadataDto[]}
   */
  toCoverMetadataDtos(raw) {
    const payload = raw && typeof raw === 'object' ? raw.payload : null;
    if (!payload || typeof payload !== 'object') {
      return [];
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

    if (!trackerId) {
      return [];
    }

    const cover = this._extractCoverMetadataDto(trackerId, payload, series);
    return cover ? [cover] : [];
  }

  /**
   * @param {string} trackerId
   * @param {Record<string, unknown>} payload
   * @param {Record<string, unknown> | null} series
   * @returns {MangaUpdatesCoverMetadataDto | null}
   */
  _extractCoverMetadataDto(trackerId, payload, series) {
    const payloadCover = payload.cover && typeof payload.cover === 'object'
      ? payload.cover
      : null;
    const seriesImage = series && series.image && typeof series.image === 'object'
      ? series.image
      : null;
    const seriesImageUrl = seriesImage && seriesImage.url && typeof seriesImage.url === 'object'
      ? seriesImage.url
      : null;

    const coverUrl = this._normalizeString(
      payload.coverUrl,
      payloadCover && payloadCover.coverUrl,
      payloadCover && payloadCover.url,
      payloadCover && payloadCover.original,
      seriesImage && seriesImage.coverUrl,
      seriesImage && seriesImage.original,
      seriesImage && seriesImage.url,
      seriesImageUrl && seriesImageUrl.original,
      seriesImageUrl && seriesImageUrl.thumb,
    );
    const thumbnailUrl = this._normalizeString(
      payload.thumbnailUrl,
      payloadCover && payloadCover.thumbnailUrl,
      payloadCover && payloadCover.thumb,
      seriesImage && seriesImage.thumbnailUrl,
      seriesImage && seriesImage.thumb,
      seriesImageUrl && seriesImageUrl.thumb,
      seriesImageUrl && seriesImageUrl.original,
    );

    if (!coverUrl && !thumbnailUrl) {
      return null;
    }

    return {
      trackerId,
      source: this.trackerId,
      coverUrl: coverUrl || null,
      thumbnailUrl: thumbnailUrl || null,
      fileName: this._normalizeString(
        payloadCover && payloadCover.fileName,
        seriesImage && seriesImage.fileName,
        seriesImageUrl && seriesImageUrl.fileName,
      ) || null,
      mimeType: this._normalizeString(
        payloadCover && payloadCover.mimeType,
        seriesImage && seriesImage.mimeType,
        seriesImageUrl && seriesImageUrl.mimeType,
      ) || null,
      width: this._normalizeNumber(
        payloadCover && payloadCover.width,
        seriesImage && seriesImage.width,
      ),
      height: this._normalizeNumber(
        payloadCover && payloadCover.height,
        seriesImage && seriesImage.height,
      ),
    };
  }

  /**
    * @param {...unknown} values
   * @returns {string | null}
   */
  _normalizeString(...values) {
    for (const value of values) {
      if (typeof value !== 'string') {
        continue;
      }
      const normalized = value.trim();
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  /**
    * @param {...unknown} values
   * @returns {number | null}
   */
  _normalizeNumber(...values) {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }

      if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }

    return null;
  }

  /**
   * @param {...unknown} values
   * @returns {number | null}
   */
  _normalizeUnitInterval(...values) {
    for (const value of values) {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        continue;
      }

      const normalized = value > 1 ? value / 100 : value;
      if (normalized < 0 || normalized > 1) {
        continue;
      }

      return normalized;
    }

    return null;
  }

  /**
   * @param {unknown[]} associated
   * @returns {string[]}
   */
  _normalizeAlternativeTitles(associated) {
    /** @type {string[]} */
    const values = [];
    this._collectStringValues(associated, values, new Set());
    return Array.from(new Set(values));
  }

  /**
   * @param {...unknown} values
   * @returns {number | null}
   */
  _resolveYear(...values) {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.trunc(value);
      }

      if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) {
          return Math.trunc(parsed);
        }
      }
    }

    return null;
  }

  /**
   * @param {unknown[]} candidates
   * @param {string[]} preferredKeys
   * @param {string} defaultType
   * @returns {Array<{ name: string, type: string }>}
   */
  _normalizeContributorEntries(candidates, preferredKeys, defaultType) {
    /** @type {Array<{ name: string, type: string }>} */
    const normalized = [];

    for (const candidate of candidates) {
      this._collectContributorEntry(candidate, normalized, preferredKeys, defaultType);
    }

    return normalized;
  }

  /**
   * @param {unknown} value
   * @param {Array<{ name: string, type: string }>} bucket
   * @param {string[]} preferredKeys
   * @param {string} defaultType
   * @returns {void}
   */
  _collectContributorEntry(value, bucket, preferredKeys, defaultType) {
    if (Array.isArray(value)) {
      value.forEach((entry) => this._collectContributorEntry(entry, bucket, preferredKeys, defaultType));
      return;
    }

    const isPublisherContributorList = Array.isArray(preferredKeys)
      && preferredKeys.some((key) => key === 'publisher_name' || key === 'publisherName' || key === 'publisher');

    /** @param {unknown} rawType */
    const normalizeContributorType = (rawType) => {
      if (typeof rawType !== 'string') {
        return '';
      }

      const trimmed = rawType.trim();
      if (!trimmed) {
        return '';
      }

      if (!isPublisherContributorList) {
        return trimmed;
      }

      return trimmed.toLowerCase() === 'publisher'
        ? 'Original'
        : trimmed;
    };

    /** @type {string} */
    let name = '';
    /** @type {string} */
    let type = '';

    if (typeof value === 'string') {
      name = value.trim();
    } else if (value && typeof value === 'object') {
      const record = /** @type {Record<string, unknown>} */ (value);

      for (const key of preferredKeys) {
        if (typeof record[key] === 'string' && record[key].trim()) {
          name = record[key].trim();
          break;
        }
      }

      if (!name) {
        const attributes = record.attributes;
        if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
          const attributeRecord = /** @type {Record<string, unknown>} */ (attributes);
          for (const key of preferredKeys) {
            if (typeof attributeRecord[key] === 'string' && attributeRecord[key].trim()) {
              name = attributeRecord[key].trim();
              break;
            }
          }

          if (!name) {
            const localizedName = this._extractLocalizedName(attributeRecord.name);
            if (localizedName) {
              name = localizedName;
            }
          }

          if (typeof attributeRecord.type === 'string' && attributeRecord.type.trim()) {
            type = normalizeContributorType(attributeRecord.type);
          } else if (typeof attributeRecord.role === 'string' && attributeRecord.role.trim()) {
            type = normalizeContributorType(attributeRecord.role);
          }
        }
      }

      if (!name) {
        const localizedName = this._extractLocalizedName(record.name);
        if (localizedName) {
          name = localizedName;
        }
      }

      if (typeof record.type === 'string' && record.type.trim()) {
        type = normalizeContributorType(record.type);
      } else if (typeof record.role === 'string' && record.role.trim()) {
        type = normalizeContributorType(record.role);
      }
    }

    if (!name) {
      return;
    }

    const normalizedType = type || defaultType;
    const normalizedName = name.toLowerCase();
    const existingSameNameIndex = bucket.findIndex((item) => item.name.toLowerCase() === normalizedName);

    if (normalizedType === defaultType) {
      if (existingSameNameIndex >= 0) {
        return;
      }
    } else if (existingSameNameIndex >= 0) {
      const existing = bucket[existingSameNameIndex];
      if (existing.type.toLowerCase() === normalizedType.toLowerCase()) {
        return;
      }
      if (existing.type.toLowerCase() === defaultType.toLowerCase()) {
        bucket.splice(existingSameNameIndex, 1);
      }
    }

    bucket.push({ name, type: normalizedType });
  }

  /**
   * @param {unknown[]} candidates
   * @param {string[]} preferredKeys
   * @returns {string[]}
   */
  _normalizeMetadataStringArray(candidates, preferredKeys) {
    /** @type {string[]} */
    const values = [];
    /** @type {Set<object>} */
    const visited = new Set();

    for (const candidate of candidates) {
      this._collectMetadataStringValues(candidate, values, visited, preferredKeys, true);
    }

    return Array.from(new Set(values));
  }

  /**
   * @param {unknown} value
   * @param {string[]} bucket
   * @param {Set<object>} visited
   * @param {string[]} preferredKeys
   * @param {boolean} allowPlainString
   * @returns {void}
   */
  _collectMetadataStringValues(value, bucket, visited, preferredKeys, allowPlainString) {
    if (typeof value === 'string') {
      if (allowPlainString) {
        const normalized = value.trim();
        if (normalized) {
          bucket.push(normalized);
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => this._collectMetadataStringValues(entry, bucket, visited, preferredKeys, allowPlainString));
      return;
    }

    if (!value || typeof value !== 'object') {
      return;
    }

    const record = /** @type {Record<string, unknown>} */ (value);
    if (visited.has(record)) {
      return;
    }
    visited.add(record);

    for (const key of preferredKeys) {
      const directValue = record[key];
      if (typeof directValue === 'string' && directValue.trim()) {
        bucket.push(directValue.trim());
        return;
      }
      if (directValue && typeof directValue === 'object') {
        const beforeLength = bucket.length;
        this._collectMetadataStringValues(directValue, bucket, visited, preferredKeys, true);
        if (bucket.length > beforeLength) {
          return;
        }
      }
    }

    const attributes = record.attributes;
    if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
      const attributeRecord = /** @type {Record<string, unknown>} */ (attributes);

      for (const key of preferredKeys) {
        const attrValue = attributeRecord[key];
        if (typeof attrValue === 'string' && attrValue.trim()) {
          bucket.push(attrValue.trim());
          return;
        }
      }

      const localizedName = this._extractLocalizedName(attributeRecord.name);
      if (localizedName) {
        bucket.push(localizedName);
        return;
      }
    }

    const localizedName = this._extractLocalizedName(record.name);
    if (localizedName) {
      bucket.push(localizedName);
    }
  }

  /**
   * @param {unknown} value
   * @returns {string | null}
   */
  _extractLocalizedName(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    for (const candidate of Object.values(value)) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    return null;
  }

  /**
   * @param {unknown} value
   * @param {string[]} bucket
   * @param {Set<object>} visited
   * @returns {void}
   */
  _collectStringValues(value, bucket, visited) {
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized) {
        bucket.push(normalized);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => this._collectStringValues(entry, bucket, visited));
      return;
    }

    if (!value || typeof value !== 'object') {
      return;
    }

    const record = /** @type {Record<string, unknown>} */ (value);
    if (visited.has(record)) {
      return;
    }
    visited.add(record);

    if (typeof record.title === 'string') {
      const normalizedTitle = record.title.trim();
      if (normalizedTitle) {
        bucket.push(normalizedTitle);
      }
      return;
    }

    Object.values(record).forEach((entry) => this._collectStringValues(entry, bucket, visited));
  }
}

module.exports = MangaUpdatesTrackerMapper;
