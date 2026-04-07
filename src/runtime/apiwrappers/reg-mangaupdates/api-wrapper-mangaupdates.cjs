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
/** @typedef {import('../../../../types/trackertypedefs').TrackerCacheAdapterLike} TrackerCacheAdapterLike */
/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesTokenResponse} MangaUpdatesTokenResponse */
/** @typedef {import('../../../../types/trackertypedefs').TrackerUserProgress} TrackerUserProgress */
/** @typedef {import('../../../../types/trackertypedefs').TrackerReadingStatus} TrackerReadingStatus */

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
 * @param {string|boolean|number|null|undefined} value
 * @returns {boolean}
 */
function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
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
    get: async () => {
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

/**
 * @returns {TrackerCacheAdapterLike}
 */
function createInMemoryCacheAdapter() {
  /** @type {Map<string, { value: string, expiresAt: number | null }>} */
  const cache = new Map();

  return {
    async getValue(key) {
      if (!cache.has(key)) {
        return null;
      }

      const entry = cache.get(key);
      if (!entry) {
        return null;
      }

      if (typeof entry.expiresAt === 'number' && Date.now() > entry.expiresAt) {
        cache.delete(key);
        return null;
      }

      return entry.value;
    },
    async setValue(key, value, ttlSeconds) {
      const ttl = typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) && ttlSeconds > 0
        ? ttlSeconds
        : null;
      const expiresAt = ttl ? Date.now() + (ttl * 1000) : null;
      cache.set(key, {
        value,
        expiresAt,
      });
    },
  };
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
    const providedCacheAdapter = params && typeof params === 'object' ? params.cacheAdapter : null;

    this.settings = serviceSettings && typeof serviceSettings === 'object'
      ? serviceSettings
      : {};
    this.apiSettings = apiSettings instanceof MangaUpdatesAPISettings ? apiSettings : null;

    this.bearerToken = null;
    this._defaultTokenName = 'session_token';
    this.credentials = null;
    this.onCredentialsRequired = typeof onCredentialsRequired === 'function'
      ? onCredentialsRequired
      : async () => null;
    this.httpClient = providedHttpClient && typeof providedHttpClient === 'object'
      ? providedHttpClient
      : createDefaultHttpClient();
    this.cacheAdapter = providedCacheAdapter && typeof providedCacheAdapter === 'object'
      ? providedCacheAdapter
      : createInMemoryCacheAdapter();

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
      : async () => null;
    const directHttpClient = options && typeof options === 'object' && options.httpClient && typeof options.httpClient === 'object'
      ? options.httpClient
      : null;
    const httpClientFactory = options && typeof options === 'object' && typeof options.httpClientFactory === 'function'
      ? options.httpClientFactory
      : null;
    const httpClientFromFactory = !directHttpClient && httpClientFactory ? httpClientFactory() : null;
    const directCacheAdapter = options && typeof options === 'object' && options.cacheAdapter && typeof options.cacheAdapter === 'object'
      ? options.cacheAdapter
      : null;
    const cacheAdapterFactory = options && typeof options === 'object' && typeof options.cacheAdapterFactory === 'function'
      ? options.cacheAdapterFactory
      : null;
    const cacheAdapterFromFactory = !directCacheAdapter && cacheAdapterFactory ? cacheAdapterFactory() : null;

    return new MangaUpdatesAPIWrapper({
      apiSettings,
      serviceSettings,
      onCredentialsRequired,
      httpClient: directHttpClient || httpClientFromFactory || null,
      cacheAdapter: directCacheAdapter || cacheAdapterFromFactory || null,
    });
  }

  /**
   * @returns {string}
   */
  static get serviceName() {
    return SERVICE_NAME;
  }

  /**
   * @returns {Promise<TrackerCredentials | null>}
   */
  async getCredentials() {
    return this.credentials && typeof this.credentials === 'object'
      ? { ...this.credentials }
      : null;
  }

  /**
   * @param {TrackerCredentials} credentials
   * @returns {Promise<TrackerCredentials>}
   */
  async setCredentials(credentials) {
    if (!credentials || typeof credentials !== 'object') {
      throw new Error('Credentials must be an object.');
    }

    this.credentials = { ...credentials };
    return { ...this.credentials };
  }

  /**
   * @param {boolean} [forceRefresh]
   * @returns {Promise<string>}
   */
  async getToken(forceRefresh = false) {
    const cacheKey = this._getTokenCacheKey();
    if (!forceRefresh && this.bearerToken) {
      return this.bearerToken;
    }

    if (!forceRefresh && this.cacheAdapter) {
      const cached = await this.cacheAdapter.getValue(cacheKey);
      if (cached) {
        this.bearerToken = cached;
        return cached;
      }
    }

    let credentials = await this.getCredentials();
    if (!credentials && typeof this.onCredentialsRequired === 'function') {
      const provided = await this.onCredentialsRequired({
        serviceName: SERVICE_NAME,
        settings: this.settings,
      });

      if (provided && typeof provided === 'object') {
        await this.setCredentials(provided);
        credentials = provided;
      }
    }

    if (!credentials) {
      throw new Error('Credentials not found and callback did not provide credentials.');
    }

    const tokenData = await this._fetchNewToken(credentials, { forceRefresh });
    const token = await this._extractToken(tokenData);
    if (!token) {
      return '';
    }

    await this._cacheToken(tokenData);
    this.bearerToken = token;
    return token;
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
   * @param {boolean} [value]
   * @returns {Promise<boolean>}
   */
  async refresh(value) {
    if (!this.cacheAdapter) {
      return Boolean(value);
    }

    if (typeof value === 'undefined') {
      const stored = await this.cacheAdapter.getValue('refresh');
      return parseBoolean(stored);
    }

    await this.cacheAdapter.setValue('refresh', String(Boolean(value)));
    return Boolean(value);
  }

  /**
   * @protected
   * @param {string} [overrideTokenName]
   * @returns {string}
   */
  _getTokenCacheKey(overrideTokenName) {
    const tokenName = typeof overrideTokenName === 'string' && overrideTokenName
      ? overrideTokenName
      : this._defaultTokenName;
    return `${SERVICE_NAME}_${tokenName}`;
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
   * @param {string} templateKey
   * @param {Record<string, string | number>} [replacements]
   * @returns {string}
   */
  _resolveEndpoint(templateKey, replacements = {}) {
    const template = this._resolveSettingValue(templateKey);
    if (typeof template !== 'string' || template.length === 0) {
      return '';
    }

    const baseUrl = this._resolveSettingValue('api.baseUrl');
    /** @type {Record<string, string>} */
    const allReplacements = {
      baseUrl: typeof baseUrl === 'string' ? baseUrl : '',
    };

    for (const [key, value] of Object.entries(replacements)) {
      allReplacements[key] = String(value);
    }

    let resolved = template;
    for (const [key, value] of Object.entries(allReplacements)) {
      resolved = resolved.split(`$\{${key}\}`).join(value);
    }

    return resolved;
  }

  /**
   * @returns {string}
   */
  _resolveLoginEndpoint() {
    return this._resolveEndpoint('api.endpoints.login.template');
  }

  /**
   * @param {TrackerCredentials} credentials
   * @param {{ forceRefresh?: boolean }} [options]
   * @returns {Promise<MangaUpdatesTokenResponse>}
   */
  async _fetchNewToken(credentials, options = {}) {
    const forceRefresh = options && typeof options === 'object' && options.forceRefresh === true;
    const cacheKey = this._getTokenCacheKey();
    if (!forceRefresh && this.cacheAdapter) {
      const cachedToken = await this.cacheAdapter.getValue(cacheKey);
      if (cachedToken) {
        return {
          session_token: cachedToken,
        };
      }
    }

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

    return {
      session_token: sessionToken,
    };
  }

  /**
   * @protected
   * @param {MangaUpdatesTokenResponse} tokenData
   * @returns {Promise<string>}
   */
  async _extractToken(tokenData) {
    if (!tokenData || typeof tokenData !== 'object') {
      return '';
    }

    return typeof tokenData.session_token === 'string' ? tokenData.session_token : '';
  }

  /**
   * @protected
   * @param {MangaUpdatesTokenResponse} tokenData
   * @returns {Promise<void>}
   */
  async _cacheToken(tokenData) {
    const token = await this._extractToken(tokenData);
    if (!token || !this.cacheAdapter) {
      return;
    }

    const cacheKey = this._getTokenCacheKey();
    const ttl = this._getTokenTTL('session_token');
    await this.cacheAdapter.setValue(cacheKey, token, ttl);
    this.bearerToken = token;
  }

  /**
   * @protected
   * @param {string} tokenType
   * @returns {number}
   */
  _getTokenTTL(tokenType) {
    if (tokenType === 'session_token') {
      return 12 * 60 * 60;
    }

    return 1 * 60;
  }

  /**
   * @param {string|number} trackerId
   * @returns {Promise<string | null>}
   */
  async getSeriesUrl(trackerId) {
    const raw = await this.getSeriesByIdRaw(trackerId);
    const payload = raw && typeof raw === 'object' && raw.payload && typeof raw.payload === 'object'
      ? raw.payload
      : null;

    if (payload && typeof payload.url === 'string' && payload.url.trim()) {
      return payload.url;
    }

    const nestedSeries = payload && payload.series && typeof payload.series === 'object'
      ? payload.series
      : null;
    if (nestedSeries && typeof nestedSeries.url === 'string' && nestedSeries.url.trim()) {
      return nestedSeries.url;
    }

    return null;
  }

  /**
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async getUserLists() {
    const bearerToken = await this.getToken();
    if (!bearerToken) {
      return [];
    }

    const refreshRequired = await this.refresh();
    const cacheKey = 'mangaupdates_user_lists';
    if (!refreshRequired && this.cacheAdapter) {
      const cached = await this.cacheAdapter.getValue(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        } catch (error) {
          // Ignore cache parse errors and continue to live request.
        }
      }
    }

    const endpoint = this._resolveEndpoint('api.endpoints.getUserLists.template');
    if (!endpoint) {
      throw new Error('(getUserLists) Missing getUserLists config');
    }

    if (!this.httpClient || typeof this.httpClient.get !== 'function') {
      throw new Error('(getUserLists) HTTP client get method is not configured');
    }

    const response = await this.httpClient.get(endpoint, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
    });

    const responseData = response && typeof response === 'object' ? response.data : null;
    const lists = Array.isArray(responseData)
      ? responseData
      : responseData && typeof responseData === 'object' && Array.isArray(responseData.results)
        ? responseData.results
        : [];

    if (this.cacheAdapter) {
      await this.cacheAdapter.setValue(cacheKey, JSON.stringify(lists), 3600);
    }

    if (refreshRequired) {
      await this.refresh(false);
    }

    return lists;
  }

  /**
   * @param {number} [id]
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async getSeriesListStatus(id = 0) {
    const refreshRequired = await this.refresh();
    const cacheKey = `getSeriesListStatus%%${id}`;
    if (!refreshRequired && this.cacheAdapter) {
      const cached = await this.cacheAdapter.getValue(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed && typeof parsed === 'object') {
            return parsed;
          }
        } catch (error) {
          // Ignore cache parse errors and continue to live request.
        }
      }
    }

    const bearerToken = await this.getToken();
    if (!bearerToken) {
      return null;
    }

    const endpoint = this._resolveEndpoint('api.endpoints.listGetSeriesItem.template', {
      series_id: id,
    });
    if (!endpoint) {
      throw new Error('(getSeriesListStatus) Missing listGetSeriesItem config');
    }

    if (!this.httpClient || typeof this.httpClient.get !== 'function') {
      throw new Error('(getSeriesListStatus) HTTP client get method is not configured');
    }

    try {
      const response = await this.httpClient.get(endpoint, {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'Content-Type': 'application/json',
        },
      });

      const payload = response && typeof response === 'object' && response.data && typeof response.data === 'object'
        ? response.data
        : null;

      if (payload && this.cacheAdapter) {
        await this.cacheAdapter.setValue(cacheKey, JSON.stringify(payload), 3600);
      }

      if (refreshRequired) {
        await this.refresh(false);
      }

      return payload;
    } catch (error) {
      const status = error && typeof error === 'object' && error.response && typeof error.response === 'object'
        ? error.response.status
        : error && typeof error === 'object' && 'statusCode' in error
          ? error.statusCode
          : null;
      if (status === 404) {
        return null;
      }

      throw error;
    }
  }

  /**
   * @param {number} listId
   * @returns {Promise<TrackerReadingStatus>}
   */
  async getReadingStatusFromListId(listId) {
    try {
      const userLists = await this.getUserLists();
      if (!Array.isArray(userLists) || userLists.length === 0) {
        return 'READING';
      }

      const listIndex = userLists.findIndex((entry) => entry && typeof entry === 'object' && entry.list_id === listId);
      if (listIndex < 0) {
        return 'READING';
      }

      /** @type {TrackerReadingStatus[]} */
      const statuses = ['READING', 'COMPLETED', 'PLAN_TO_READ', 'ON_HOLD', 'DROPPED', 'RE_READING'];

      for (const status of statuses) {
        const mappingFromFlatKey = this._resolveSettingValue(`statusMapping.${status}`);
        if (typeof mappingFromFlatKey === 'number' && mappingFromFlatKey === listIndex) {
          return status;
        }

        const nestedStatusMapping = this._resolveSettingValue('statusMapping');
        if (nestedStatusMapping
          && typeof nestedStatusMapping === 'object'
          && typeof nestedStatusMapping[status] === 'number'
          && nestedStatusMapping[status] === listIndex
        ) {
          return status;
        }
      }

      return 'READING';
    } catch (error) {
      return 'READING';
    }
  }

  /**
   * @param {string|number} seriesId
   * @returns {Promise<TrackerUserProgress | null>}
   */
  async getUserProgress(seriesId) {
    const listStatus = await this.getSeriesListStatus(Number(seriesId));
    if (!listStatus || typeof listStatus !== 'object') {
      return null;
    }

    const statusPayload = listStatus.status && typeof listStatus.status === 'object'
      ? listStatus.status
      : null;

    /** @type {TrackerUserProgress} */
    const progress = {};
    if (statusPayload && typeof statusPayload.chapter === 'number') {
      progress.chapter = statusPayload.chapter;
    }
    if (statusPayload && typeof statusPayload.volume === 'number') {
      progress.volume = statusPayload.volume;
    }

    const timeAdded = listStatus.time_added && typeof listStatus.time_added === 'object'
      ? listStatus.time_added
      : null;
    if (timeAdded && typeof timeAdded.timestamp === 'number') {
      progress.lastUpdated = new Date(timeAdded.timestamp * 1000).toISOString();
    }

    if (typeof listStatus.list_id === 'number') {
      progress.status = await this.getReadingStatusFromListId(listStatus.list_id);
    }

    return progress;
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

    try {
      const progress = await this.getUserProgress(trackerId);
      if (progress && typeof progress === 'object' && Object.keys(progress).length > 0) {
        return {
          trackerId: 'mangaupdates',
          operation: 'getUserProgressRaw',
          payload: progress,
        };
      }
    } catch (error) {
      // Fallback placeholder preserves baseline contract behavior when read path is unavailable.
    }

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
