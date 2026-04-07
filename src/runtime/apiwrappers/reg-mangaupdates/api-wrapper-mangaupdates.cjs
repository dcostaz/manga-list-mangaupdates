'use strict';

const path = require('path');
const MangaUpdatesAPISettings = require(path.join(__dirname, 'api-settings-mangaupdates.cjs'));

/** @typedef {import('../../../../types/trackertypedefs').TrackerServiceSettings} TrackerServiceSettings */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesAPIWrapperCtorParams} MangaUpdatesAPIWrapperCtorParams */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesAPIWrapperInitOptions} MangaUpdatesAPIWrapperInitOptions */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesRawSearchResponse} MangaUpdatesRawSearchResponse */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesRawEntityResponse} MangaUpdatesRawEntityResponse */

class MangaUpdatesAPIWrapper {
  /**
  * @param {MangaUpdatesAPIWrapperCtorParams} [params]
   * @param {MangaUpdatesAPISettings | null} [params.apiSettings]
  * @param {TrackerServiceSettings} [params.serviceSettings]
   */
  constructor(params = {}) {
    const apiSettings = params && typeof params === 'object' ? params.apiSettings : null;
    const serviceSettings = params && typeof params === 'object' ? params.serviceSettings : null;

    this.settings = serviceSettings && typeof serviceSettings === 'object' ? serviceSettings : {};
    this.apiSettings = apiSettings instanceof MangaUpdatesAPISettings ? apiSettings : null;
  }

  /**
    * @param {MangaUpdatesAPIWrapperInitOptions} [options]
   * @param {MangaUpdatesAPISettings | null} [options.apiSettings]
    * @param {TrackerServiceSettings} [options.serviceSettings]
   * @returns {Promise<MangaUpdatesAPIWrapper>}
   */
  static async init(options = {}) {
    const apiSettings = options && typeof options === 'object' && options.apiSettings instanceof MangaUpdatesAPISettings
      ? options.apiSettings
      : null;

    return new MangaUpdatesAPIWrapper({
      apiSettings,
      serviceSettings: options && typeof options === 'object' ? options.serviceSettings : null,
    });
  }

  /**
   * @param {string} query
    * @returns {Promise<MangaUpdatesRawSearchResponse>}
   */
  async searchTrackersRaw(query) {
    const normalizedQuery = typeof query === 'string' ? query.trim() : '';
    const items = normalizedQuery
      ? [{ id: `mu-${normalizedQuery.toLowerCase()}`, title: normalizedQuery }]
      : [];

    return {
      trackerId: 'mangaupdates',
      operation: 'searchTrackersRaw',
      payload: { data: items },
    };
  }

  /**
   * @param {string} trackerId
    * @returns {Promise<MangaUpdatesRawEntityResponse>}
   */
  async getSeriesByIdRaw(trackerId) {
    const normalizedTrackerId = typeof trackerId === 'string' ? trackerId.trim() : '';
    return {
      trackerId: 'mangaupdates',
      operation: 'getSeriesByIdRaw',
      payload: {
        id: normalizedTrackerId || 'unknown',
        title: normalizedTrackerId || 'Unknown MangaUpdates Title',
      },
    };
  }

  /**
   * @param {string} trackerId
    * @returns {Promise<MangaUpdatesRawEntityResponse>}
   */
  async getUserProgressRaw(trackerId) {
    const normalizedTrackerId = typeof trackerId === 'string' ? trackerId.trim() : '';
    return {
      trackerId: 'mangaupdates',
      operation: 'getUserProgressRaw',
      payload: {
        trackerId: normalizedTrackerId || null,
        status: 'reading',
        chapter: 0,
        volume: null,
      },
    };
  }
}

MangaUpdatesAPIWrapper.serviceName = 'mangaupdates';

module.exports = MangaUpdatesAPIWrapper;
