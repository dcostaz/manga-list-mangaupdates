'use strict';

const path = require('path');
const MangaUpdatesAPISettings = require(path.join(__dirname, 'api-settings-mangaupdates.cjs'));

const SERVICE_NAME = 'mangaupdates';

/** @typedef {import('../../../../types/trackertypedefs').TrackerServiceSettings} TrackerServiceSettings */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesAPIWrapperCtorParams} MangaUpdatesAPIWrapperCtorParams */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesAPIWrapperInitOptions} MangaUpdatesAPIWrapperInitOptions */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesRawSearchResponse} MangaUpdatesRawSearchResponse */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesRawEntityResponse} MangaUpdatesRawEntityResponse */
/** @typedef {import('../../../../types/trackertypedefs').TrackerHttpClientLike} TrackerHttpClientLike */
/** @typedef {import('../../../../types/trackertypedefs').TrackerCredentials} TrackerCredentials */

/**
 * @param {string} html
 * @returns {string}
 */
function extractHtmlErrorMessage(html) {
  if (typeof html !== 'string') {
    return 'Unknown HTML error response';
  }

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch && typeof titleMatch[1] === 'string' && titleMatch[1].trim()) {
    return titleMatch[1].trim();
  }

  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return bodyText ? bodyText.slice(0, 180) : 'Unknown HTML error response';
}

/**
 * @returns {TrackerHttpClientLike}
 */
function createFallbackHttpClient() {
  return {
    interceptors: {
      response: {
        use: () => 0,
      },
    },
    put: async () => {
      throw new Error('HTTP client is not configured for MangaUpdates runtime wrapper.');
    },
  };
}

/**
 * @returns {TrackerHttpClientLike}
 */
function createDefaultHttpClient() {
  try {
    const axiosModule = require('axios');
    const axios = axiosModule && axiosModule.default ? axiosModule.default : axiosModule;
    if (axios && typeof axios.create === 'function') {
      return axios.create();
    }
  } catch (error) {
    // Fallback is used when axios is not installed in this runtime environment.
  }

  return createFallbackHttpClient();
}

class MangaUpdatesAPIWrapper {
  /**
   * @param {MangaUpdatesAPIWrapperCtorParams} [params]
   * @param {MangaUpdatesAPISettings | null} [params.apiSettings]
   * @param {TrackerServiceSettings} [params.serviceSettings]
   */
  constructor(params = {}) {
    const apiSettings = params && typeof params === 'object' ? params.apiSettings : null;
    const serviceSettings = params && typeof params === 'object' ? params.serviceSettings : null;
    const onCredentialsRequired = params && typeof params === 'object'
      ? params.onCredentialsRequired
      : null;
    const providedHttpClient = params && typeof params === 'object' ? params.httpClient : null;

    this.settings = serviceSettings && typeof serviceSettings === 'object'
      ? serviceSettings
      : {};
    this.apiSettings = apiSettings instanceof MangaUpdatesAPISettings ? apiSettings : null;

    this.bearerToken = null;
    this._defaultTokenName = 'session_token';
    this.onCredentialsRequired = typeof onCredentialsRequired === 'function'
      ? onCredentialsRequired
      : async () => {};
    this.httpClient = providedHttpClient && typeof providedHttpClient === 'object'
      ? providedHttpClient
      : createDefaultHttpClient();

    this._setupAxiosInterceptor();
  }

  /**
   * Detect HTML responses and normalize them as infrastructure errors.
   *
   * @returns {void}
   */
  _setupAxiosInterceptor() {
    const responseInterceptors = this.httpClient
      && this.httpClient.interceptors
      && this.httpClient.interceptors.response
      && typeof this.httpClient.interceptors.response.use === 'function'
      ? this.httpClient.interceptors.response
      : null;

    if (!responseInterceptors) {
      return;
    }

    responseInterceptors.use(
      (response) => response,
      (error) => {
        const response = error && typeof error === 'object' && error.response && typeof error.response === 'object'
          ? error.response
          : null;

        if (!response) {
          return Promise.reject(error);
        }

        const headers = response.headers && typeof response.headers === 'object' ? response.headers : {};
        const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'] : '';
        const responseData = response.data;
        const looksLikeHtml = contentType.includes('text/html')
          || (typeof responseData === 'string' && /^\s*<(?:!doctype|html)/i.test(responseData));

        if (!looksLikeHtml) {
          return Promise.reject(error);
        }

        const cleanError = new Error(
          `MangaUpdates backend infrastructure error: ${extractHtmlErrorMessage(typeof responseData === 'string' ? responseData : '')}`,
        );
        cleanError.name = 'MangaUpdatesBackendError';
        // @ts-ignore custom compatibility fields used by runtime consumers.
        cleanError.statusCode = typeof response.status === 'number' ? response.status : null;
        // @ts-ignore custom compatibility fields used by runtime consumers.
        cleanError.isInfrastructureError = true;
        // @ts-ignore custom compatibility fields used by runtime consumers.
        cleanError.originalError = error;

        return Promise.reject(cleanError);
      },
    );
  }

  /**
   * @param {MangaUpdatesAPIWrapperInitOptions} [options]
   * @param {MangaUpdatesAPISettings | null} [options.apiSettings]
   * @param {TrackerServiceSettings} [options.serviceSettings]
   * @returns {Promise<MangaUpdatesAPIWrapper>}
   */
  static async init(options = {}) {
    let apiSettings = options && typeof options === 'object' && options.apiSettings instanceof MangaUpdatesAPISettings
      ? options.apiSettings
      : null;
    const settingsPath = options && typeof options === 'object' && typeof options.settingsPath === 'string'
      ? options.settingsPath
      : '';

    if (!apiSettings && settingsPath) {
      apiSettings = await MangaUpdatesAPISettings.init({ settingsPath });
    }

    const explicitServiceSettings = options && typeof options === 'object' && options.serviceSettings
      && typeof options.serviceSettings === 'object'
      ? options.serviceSettings
      : null;
    const serviceSettingsFromApiSettings = apiSettings ? apiSettings.toLegacyFormat() : null;
    const serviceSettings = explicitServiceSettings || serviceSettingsFromApiSettings || {};

    const onCredentialsRequired = options && typeof options === 'object' && typeof options.onCredentialsRequired === 'function'
      ? options.onCredentialsRequired
      : async () => {};
    const directHttpClient = options && typeof options === 'object' && options.httpClient && typeof options.httpClient === 'object'
      ? options.httpClient
      : null;
    const httpClientFactory = options && typeof options === 'object' && typeof options.httpClientFactory === 'function'
      ? options.httpClientFactory
      : null;
    const httpClientFromFactory = !directHttpClient && httpClientFactory ? httpClientFactory() : null;

    return new MangaUpdatesAPIWrapper({
      apiSettings,
      serviceSettings,
      onCredentialsRequired,
      httpClient: directHttpClient || httpClientFromFactory || null,
    });
  }

  /**
   * @returns {string}
   */
  static get serviceName() {
    return SERVICE_NAME;
  }

  /**
   * @param {TrackerCredentials} credentials
   * @returns {Promise<boolean>}
   */
  async testCredentials(credentials) {
    try {
      const token = await this._fetchNewToken(credentials, { forceRefresh: true });
      return token && typeof token.session_token === 'string' && token.session_token.length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * @param {string} dottedKey
   * @returns {unknown}
   */
  _resolveSettingValue(dottedKey) {
    if (!dottedKey) {
      return undefined;
    }

    if (this.settings && typeof this.settings === 'object' && dottedKey in this.settings) {
      return this.settings[dottedKey];
    }

    const pathSegments = dottedKey.split('.');
    let cursor = this.settings;
    for (const segment of pathSegments) {
      if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) {
        return undefined;
      }
      cursor = cursor[segment];
    }

    return cursor;
  }

  /**
   * @returns {string}
   */
  _resolveLoginEndpoint() {
    const template = this._resolveSettingValue('api.endpoints.login.template');
    const baseUrl = this._resolveSettingValue('api.baseUrl');

    if (typeof template !== 'string' || !template) {
      return '';
    }

    const resolvedBaseUrl = typeof baseUrl === 'string' ? baseUrl : '';
    return template.replace('${baseUrl}', resolvedBaseUrl);
  }

  /**
   * @param {TrackerCredentials} credentials
   * @param {{ forceRefresh?: boolean }} [options]
   * @returns {Promise<{ session_token: string }>}
   */
  async _fetchNewToken(credentials, options = {}) {
    const endpoint = this._resolveLoginEndpoint();
    if (!endpoint) {
      throw new Error('(_fetchNewToken) Error: Missing login config');
    }

    const requestPayload = credentials && typeof credentials === 'object' ? credentials : {};
    if (!this.httpClient || typeof this.httpClient.put !== 'function') {
      throw new Error('(_fetchNewToken) Error: HTTP client is not configured');
    }

    const response = await this.httpClient.put(
      endpoint,
      requestPayload,
      { headers: { 'Content-Type': 'application/json' } },
    );
    const responseData = response && typeof response === 'object' ? response.data : null;
    const context = responseData && typeof responseData === 'object' ? responseData.context : null;
    const sessionToken = context && typeof context === 'object' && typeof context.session_token === 'string'
      ? context.session_token
      : responseData && typeof responseData === 'object' && typeof responseData.session_token === 'string'
        ? responseData.session_token
        : '';

    if (!sessionToken) {
      throw new Error('(_fetchNewToken) Error: Missing session token in login response');
    }

    if (options && typeof options === 'object' && options.forceRefresh) {
      this.bearerToken = sessionToken;
    }

    return {
      session_token: sessionToken,
    };
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

module.exports = MangaUpdatesAPIWrapper;
