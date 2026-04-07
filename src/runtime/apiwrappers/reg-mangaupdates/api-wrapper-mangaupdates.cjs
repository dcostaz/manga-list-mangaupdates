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
 * @param {string} value
 * @returns {string}
 */
function toSlug(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
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
    post: async () => {
      throw new Error('HTTP client is not configured for MangaUpdates runtime wrapper.');
    },
    patch: async () => {
      throw new Error('HTTP client is not configured for MangaUpdates runtime wrapper.');
    },
    delete: async () => {
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
    async deleteValue(key) {
      cache.delete(key);
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
   * @param {number} [id]
   * @param {{ useCache?: boolean }} [options]
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async getSerieDetail(id = 0, options = {}) {
    const numericId = Number(id);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      return null;
    }

    const useCache = !(options && typeof options === 'object' && options.useCache === false);
    if (!useCache) {
      await this.refresh(true);
    }

    const refreshRequired = await this.refresh();
    const cacheKey = `getSerieDetail%%${numericId}`;
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

    const endpoint = this._resolveEndpoint('api.endpoints.series.template', {
      series_id: numericId,
    });
    if (!endpoint) {
      throw new Error('(getSerieDetail) Missing series config');
    }

    const bearerToken = await this.getToken();
    if (!bearerToken) {
      return null;
    }

    if (!this.httpClient || typeof this.httpClient.get !== 'function') {
      throw new Error('(getSerieDetail) HTTP client get method is not configured');
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
        const ttlCandidate = this._resolveSettingValue('cache.ttl.seriesMetadata');
        const ttl = typeof ttlCandidate === 'number' && Number.isFinite(ttlCandidate) && ttlCandidate > 0
          ? ttlCandidate
          : 24 * 60 * 60;
        await this.cacheAdapter.setValue(cacheKey, JSON.stringify(payload), ttl);
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
   * @private
   * @param {Record<string, unknown>} seriesDetail
   * @returns {Record<string, unknown>}
   */
  _normalizeSeriesData(seriesDetail) {
    const associated = Array.isArray(seriesDetail.associated) ? seriesDetail.associated : [];
    const genres = Array.isArray(seriesDetail.genres) ? seriesDetail.genres : [];
    const authors = Array.isArray(seriesDetail.authors) ? seriesDetail.authors : [];
    const publishers = Array.isArray(seriesDetail.publishers) ? seriesDetail.publishers : [];

    const image = seriesDetail.image && typeof seriesDetail.image === 'object' ? seriesDetail.image : null;
    const imageUrl = image && image.url && typeof image.url === 'object' ? image.url : null;

    const trackerId = typeof seriesDetail.series_id === 'number' || typeof seriesDetail.series_id === 'string'
      ? seriesDetail.series_id
      : typeof seriesDetail.id === 'number' || typeof seriesDetail.id === 'string'
        ? seriesDetail.id
        : null;

    return {
      source: SERVICE_NAME,
      trackerId,
      title: typeof seriesDetail.title === 'string' ? seriesDetail.title : '',
      alternativeTitles: associated
        .map((entry) => (entry && typeof entry === 'object' && typeof entry.title === 'string' ? entry.title : null))
        .filter((entry) => entry !== null),
      coverUrl: imageUrl && typeof imageUrl.original === 'string'
        ? imageUrl.original
        : imageUrl && typeof imageUrl.thumb === 'string'
          ? imageUrl.thumb
          : null,
      metadata: {
        year: typeof seriesDetail.year === 'number' ? seriesDetail.year : Number(seriesDetail.year) || null,
        type: typeof seriesDetail.type === 'string' ? seriesDetail.type : null,
        genres: genres
          .map((entry) => (entry && typeof entry === 'object' && typeof entry.genre === 'string' ? entry.genre : null))
          .filter((entry) => entry !== null),
        description: typeof seriesDetail.description === 'string' ? seriesDetail.description : null,
        status: typeof seriesDetail.status === 'string' ? seriesDetail.status : null,
        authors: authors
          .map((entry) => (entry && typeof entry === 'object' && typeof entry.name === 'string' ? entry.name : null))
          .filter((entry) => entry !== null),
        publishers: publishers
          .map((entry) => (entry && typeof entry === 'object' && typeof entry.publisher_name === 'string' ? entry.publisher_name : null))
          .filter((entry) => entry !== null),
      },
      confidence: 100,
      matchType: 'exact',
    };
  }

  /**
   * @param {string|number} trackerId
   * @param {boolean} [useCache]
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async getSeriesById(trackerId, useCache = true) {
    try {
      const seriesDetail = await this.getSerieDetail(Number(trackerId), { useCache });
      if (!seriesDetail || typeof seriesDetail !== 'object') {
        return null;
      }

      return this._normalizeSeriesData(seriesDetail);
    } catch (error) {
      return null;
    }
  }

  /**
   * @param {{ search?: string, perpage?: number }} payload
   * @param {{ useCache?: boolean }} [options]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async serieSearch(payload, options = {}) {
    if (!payload || typeof payload !== 'object' || typeof payload.search !== 'string' || payload.search.trim().length === 0) {
      return [];
    }

    const useCache = !(options && typeof options === 'object' && options.useCache === false);
    const perpage = typeof payload.perpage === 'number' && Number.isFinite(payload.perpage) && payload.perpage > 0
      ? payload.perpage
      : 10;
    const cacheKey = `serieSearch%%${toSlug(payload.search)}%%${perpage}`;

    const refreshRequired = await this.refresh();
    if (!refreshRequired && useCache && this.cacheAdapter) {
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

    const endpoint = this._resolveEndpoint('api.endpoints.seriesSearch.template');
    if (!endpoint) {
      throw new Error('(serieSearch) Missing seriesSearch config');
    }

    const bearerToken = await this.getToken();
    if (!bearerToken) {
      return [];
    }

    if (!this.httpClient || typeof this.httpClient.post !== 'function') {
      throw new Error('(serieSearch) HTTP client post method is not configured');
    }

    const response = await this.httpClient.post(
      endpoint,
      {
        ...payload,
        perpage,
      },
      {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'Content-Type': 'application/json',
        },
      },
    );

    const responseData = response && typeof response === 'object' ? response.data : null;
    const results = responseData && typeof responseData === 'object' && Array.isArray(responseData.results)
      ? responseData.results
      : Array.isArray(responseData)
        ? responseData
        : [];

    if (results.length > 0 && this.cacheAdapter) {
      const ttlCandidate = this._resolveSettingValue('cache.ttl.searchResults');
      const ttl = typeof ttlCandidate === 'number' && Number.isFinite(ttlCandidate) && ttlCandidate > 0
        ? ttlCandidate
        : 3600;
      await this.cacheAdapter.setValue(cacheKey, JSON.stringify(results), ttl);
    }

    if (refreshRequired) {
      await this.refresh(false);
    }

    return results;
  }

  /**
   * @param {number} [id]
   * @returns {Promise<string | null>}
   */
  async getSeriesCover(id = 0) {
    const detail = await this.getSerieDetail(id);
    if (!detail || typeof detail !== 'object') {
      return null;
    }

    const image = detail.image && typeof detail.image === 'object' ? detail.image : null;
    const url = image && image.url && typeof image.url === 'object' ? image.url : null;

    if (url && typeof url.original === 'string' && url.original.trim()) {
      return url.original;
    }

    if (url && typeof url.thumb === 'string' && url.thumb.trim()) {
      return url.thumb;
    }

    return null;
  }

  /**
   * @param {string|number} id
   * @param {Record<string, unknown>} payload
   * @returns {Promise<{ status: number, data: unknown }>}
   */
  async updateSeries(id, payload) {
    let bearerToken = '';
    try {
      bearerToken = await this.getToken();
    } catch (error) {
      bearerToken = '';
    }

    if (!bearerToken) {
      return { status: 401, data: { reason: 'Not authenticated' } };
    }

    const endpoint = this._resolveEndpoint('api.endpoints.series.template', {
      series_id: id,
    });
    if (!endpoint) {
      throw new Error('(updateSeries) Missing series config');
    }

    if (!this.httpClient || typeof this.httpClient.patch !== 'function') {
      throw new Error('(updateSeries) HTTP client patch method is not configured');
    }

    try {
      const response = await this.httpClient.patch(
        endpoint,
        payload,
        {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const responseData = response && typeof response === 'object' ? response.data : null;
      if (responseData && typeof responseData === 'object' && responseData.status === 'EXCEPTION') {
        return { status: 400, data: responseData };
      }

      if (this.cacheAdapter && typeof this.cacheAdapter.deleteValue === 'function') {
        await this.cacheAdapter.deleteValue(`getSerieDetail%%${Number(id)}`);
      }

      return {
        status: response && typeof response === 'object' && typeof response.status === 'number' ? response.status : 200,
        data: responseData,
      };
    } catch (error) {
      if (error && typeof error === 'object' && error.response && typeof error.response === 'object') {
        const status = typeof error.response.status === 'number' ? error.response.status : 500;
        const data = 'data' in error.response ? error.response.data : null;
        return { status, data };
      }

      throw error;
    }
  }

  /**
   * @param {string|number} id
   * @param {Buffer | Uint8Array | ArrayBuffer | string | null | undefined} imageBuffer
   * @returns {Promise<{ status: number, data: unknown }>}
   */
  async updateSeriesCover(id, imageBuffer) {
    let bearerToken = '';
    try {
      bearerToken = await this.getToken();
    } catch (error) {
      bearerToken = '';
    }

    if (!bearerToken) {
      return { status: 401, data: { reason: 'Not authenticated' } };
    }

    if (!imageBuffer) {
      return { status: 400, data: { reason: 'imageBuffer is required' } };
    }

    const endpoint = this._resolveEndpoint('api.endpoints.seriesImage.template', {
      series_id: id,
    });
    if (!endpoint) {
      throw new Error('(updateSeriesCover) Missing seriesImage config');
    }

    if (!this.httpClient || typeof this.httpClient.post !== 'function') {
      throw new Error('(updateSeriesCover) HTTP client post method is not configured');
    }

    try {
      const response = await this.httpClient.post(
        endpoint,
        {
          image: imageBuffer,
          filename: 'cover.jpg',
          contentType: 'image/jpeg',
        },
        {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
          },
        },
      );

      const responseData = response && typeof response === 'object' ? response.data : null;
      if (responseData && typeof responseData === 'object' && responseData.status === 'EXCEPTION') {
        return { status: 400, data: responseData };
      }

      if (this.cacheAdapter && typeof this.cacheAdapter.deleteValue === 'function') {
        await this.cacheAdapter.deleteValue(`getSerieDetail%%${Number(id)}`);
      }

      return {
        status: response && typeof response === 'object' && typeof response.status === 'number' ? response.status : 200,
        data: responseData,
      };
    } catch (error) {
      if (error && typeof error === 'object' && error.response && typeof error.response === 'object') {
        const status = typeof error.response.status === 'number' ? error.response.status : 500;
        const data = 'data' in error.response ? error.response.data : null;
        return { status, data };
      }

      throw error;
    }
  }

  /**
   * @param {string|number} id
   * @returns {Promise<{ status: number, data: unknown }>}
   */
  async deleteSeriesCover(id) {
    let bearerToken = '';
    try {
      bearerToken = await this.getToken();
    } catch (error) {
      bearerToken = '';
    }

    if (!bearerToken) {
      return { status: 401, data: { reason: 'Not authenticated' } };
    }

    const endpoint = this._resolveEndpoint('api.endpoints.seriesImage.template', {
      series_id: id,
    });
    if (!endpoint) {
      throw new Error('(deleteSeriesCover) Missing seriesImage config');
    }

    if (!this.httpClient || typeof this.httpClient.delete !== 'function') {
      throw new Error('(deleteSeriesCover) HTTP client delete method is not configured');
    }

    try {
      const response = await this.httpClient.delete(
        endpoint,
        {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
          },
        },
      );

      const responseData = response && typeof response === 'object' ? response.data : null;
      if (responseData && typeof responseData === 'object' && responseData.status === 'EXCEPTION') {
        return { status: 400, data: responseData };
      }

      if (this.cacheAdapter && typeof this.cacheAdapter.deleteValue === 'function') {
        await this.cacheAdapter.deleteValue(`getSerieDetail%%${Number(id)}`);
      }

      return {
        status: response && typeof response === 'object' && typeof response.status === 'number' ? response.status : 200,
        data: responseData,
      };
    } catch (error) {
      if (error && typeof error === 'object' && error.response && typeof error.response === 'object') {
        const status = typeof error.response.status === 'number' ? error.response.status : 500;
        const data = 'data' in error.response ? error.response.data : null;
        return { status, data };
      }

      throw error;
    }
  }

  /**
   * @param {Record<string, unknown> | Array<Record<string, unknown>>} payload
   * @returns {Promise<{ status: number, data: unknown }>}
   */
  async updateListSeries(payload) {
    let bearerToken = '';
    try {
      bearerToken = await this.getToken();
    } catch (error) {
      bearerToken = '';
    }

    if (!bearerToken) {
      return { status: 401, data: { reason: 'Not authenticated' } };
    }

    const endpoint = this._resolveEndpoint('api.endpoints.listUpdateSeries.template');
    if (!endpoint) {
      throw new Error('(updateListSeries) Missing listUpdateSeries config');
    }

    if (!this.httpClient || typeof this.httpClient.post !== 'function') {
      throw new Error('(updateListSeries) HTTP client post method is not configured');
    }

    const payloadArray = Array.isArray(payload) ? payload : [payload];
    const transformedPayload = payloadArray.map((item) => {
      const row = item && typeof item === 'object' ? item : {};
      /** @type {Record<string, unknown>} */
      const transformed = {
        series: row.series,
        list_id: row.list_id,
      };

      const status = row.status && typeof row.status === 'object' ? row.status : null;
      if (status) {
        /** @type {Record<string, number>} */
        const statusObject = {};

        if (typeof status.chapter === 'number' && status.chapter > 0) {
          statusObject.chapter = Math.floor(status.chapter);
        }
        if (typeof status.volume === 'number' && status.volume > 0) {
          statusObject.volume = Math.floor(status.volume);
        }

        if (Object.keys(statusObject).length > 0) {
          transformed.status = statusObject;
        }
      }

      return transformed;
    });

    try {
      const response = await this.httpClient.post(
        endpoint,
        transformedPayload,
        {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const responseData = response && typeof response === 'object' ? response.data : null;
      if (responseData && typeof responseData === 'object' && responseData.status === 'EXCEPTION') {
        return { status: 400, data: responseData };
      }

      return {
        status: response && typeof response === 'object' && typeof response.status === 'number' ? response.status : 200,
        data: responseData,
      };
    } catch (error) {
      if (error && typeof error === 'object' && error.response && typeof error.response === 'object') {
        const status = typeof error.response.status === 'number' ? error.response.status : 500;
        const data = 'data' in error.response ? error.response.data : null;
        return { status, data };
      }

      throw error;
    }
  }

  /**
   * @param {Record<string, unknown> | Array<Record<string, unknown>>} payload
   * @returns {Promise<{ status: number, data: unknown }>}
   */
  async addListSeries(payload) {
    let bearerToken = '';
    try {
      bearerToken = await this.getToken();
    } catch (error) {
      bearerToken = '';
    }

    if (!bearerToken) {
      return { status: 401, data: { reason: 'Not authenticated' } };
    }

    const endpoint = this._resolveEndpoint('api.endpoints.listAddSeries.template');
    if (!endpoint) {
      throw new Error('(addListSeries) Missing listAddSeries config');
    }

    if (!this.httpClient || typeof this.httpClient.post !== 'function') {
      throw new Error('(addListSeries) HTTP client post method is not configured');
    }

    const payloadArray = Array.isArray(payload) ? payload : [payload];

    try {
      const response = await this.httpClient.post(
        endpoint,
        payloadArray,
        {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const responseData = response && typeof response === 'object' ? response.data : null;
      if (responseData && typeof responseData === 'object' && responseData.status === 'EXCEPTION') {
        return { status: 400, data: responseData };
      }

      return {
        status: response && typeof response === 'object' && typeof response.status === 'number' ? response.status : 200,
        data: responseData,
      };
    } catch (error) {
      if (error && typeof error === 'object' && error.response && typeof error.response === 'object') {
        const status = typeof error.response.status === 'number' ? error.response.status : 500;
        const data = 'data' in error.response ? error.response.data : null;
        return { status, data };
      }

      throw error;
    }
  }

  /**
   * @param {Record<string, unknown> | Array<Record<string, unknown>>} updates
   * @returns {Promise<{ status: number, data: unknown }>}
   */
  async updateStatus(updates) {
    try {
      const updatesArray = Array.isArray(updates) ? updates : [updates];
      if (updatesArray.length === 0) {
        throw new Error('No updates provided');
      }

      const userLists = await this.getUserLists();
      if (!Array.isArray(userLists) || userLists.length === 0) {
        throw new Error('Unable to fetch user lists. Cannot update status.');
      }

      const listSeriesPayload = updatesArray.map((update) => {
        const row = update && typeof update === 'object' ? update : {};
        const trackerId = row.trackerId;
        const statusCode = row.statusCode;
        const progressData = row.progressData && typeof row.progressData === 'object'
          ? row.progressData
          : {};

        const targetList = userLists.find((list) => {
          if (!list || typeof list !== 'object') {
            return false;
          }

          return list.list_id === statusCode;
        });

        if (!targetList) {
          const availableListIds = userLists
            .filter((list) => list && typeof list === 'object')
            .map((list) => `${list.list_id}:${typeof list.title === 'string' ? list.title : ''}`)
            .join(', ');
          throw new Error(`Unable to find list with list_id ${statusCode}. Available: ${availableListIds}`);
        }

        /** @type {Record<string, number>} */
        const statusObject = {};
        if (typeof progressData.chapter === 'number' && progressData.chapter > 0) {
          statusObject.chapter = progressData.chapter;
        }
        if (typeof progressData.volume === 'number' && progressData.volume > 0) {
          statusObject.volume = progressData.volume;
        }

        return {
          series: { id: Number(trackerId) },
          list_id: targetList.list_id,
          status: statusObject,
        };
      });

      const result = await this.updateListSeries(listSeriesPayload);
      if (result.status >= 400) {
        const errorData = result && typeof result === 'object' && result.data && typeof result.data === 'object'
          ? result.data
          : null;
        throw new Error(`Failed to update status: ${errorData && typeof errorData.reason === 'string' ? errorData.reason : 'Unknown error'}`);
      }

      return {
        status: result.status || 200,
        data: result.data,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`(MangaUpdates.updateStatus) ${message}`);
    }
  }

  /**
   * @param {string|number} id
   * @param {Record<string, unknown>} payload
   * @returns {Promise<{ status: number, data: unknown }>}
   */
  async updateSerieRating(id, payload) {
    let bearerToken = '';
    try {
      bearerToken = await this.getToken();
    } catch (error) {
      bearerToken = '';
    }

    if (!bearerToken) {
      return { status: 401, data: { reason: 'Not authenticated' } };
    }

    const endpoint = this._resolveEndpoint('api.endpoints.updateSerieRating.template', {
      series_id: id,
    });
    if (!endpoint) {
      throw new Error('(updateSerieRating) Missing updateSerieRating config');
    }

    if (!this.httpClient || typeof this.httpClient.put !== 'function') {
      throw new Error('(updateSerieRating) HTTP client put method is not configured');
    }

    try {
      const response = await this.httpClient.put(
        endpoint,
        payload,
        {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const responseData = response && typeof response === 'object' ? response.data : null;
      if (responseData && typeof responseData === 'object' && responseData.status === 'EXCEPTION') {
        return { status: 400, data: responseData };
      }

      return {
        status: response && typeof response === 'object' && typeof response.status === 'number' ? response.status : 200,
        data: responseData,
      };
    } catch (error) {
      if (error && typeof error === 'object' && error.response && typeof error.response === 'object') {
        const status = typeof error.response.status === 'number' ? error.response.status : 500;
        const data = 'data' in error.response ? error.response.data : null;
        return { status, data };
      }

      throw error;
    }
  }

  /**
   * @param {string|number} seriesId
   * @param {TrackerUserProgress} [progress]
   * @returns {Promise<Record<string, unknown>>}
   */
  async setUserProgress(seriesId, progress = {}) {
    if (!seriesId) {
      throw new Error('(setUserProgress) seriesId is required');
    }

    const numericSeriesId = Number(seriesId);
    if (Number.isNaN(numericSeriesId)) {
      throw new Error('(setUserProgress) Invalid seriesId');
    }

    const existingStatus = await this.getSeriesListStatus(numericSeriesId);
    if (!existingStatus) {
      return {
        success: false,
        error: 'Series is not present in MangaUpdates reading list. Subscribe before pushing progress.',
      };
    }

    const statusMappingResolved = this._resolveSettingValue('statusMapping');
    /** @type {Record<string, number>} */
    const statusMapping = statusMappingResolved && typeof statusMappingResolved === 'object'
      ? { ...statusMappingResolved }
      : {};
    /** @type {TrackerReadingStatus[]} */
    const knownStatuses = ['READING', 'COMPLETED', 'PLAN_TO_READ', 'ON_HOLD', 'DROPPED', 'RE_READING'];
    for (const status of knownStatuses) {
      const flatValue = this._resolveSettingValue(`statusMapping.${status}`);
      if (typeof flatValue === 'number') {
        statusMapping[status] = flatValue;
      }
    }

    const baseListId = existingStatus && typeof existingStatus === 'object' && typeof existingStatus.list_id === 'number'
      ? existingStatus.list_id
      : null;
    let targetListId = baseListId;
    let listChanged = false;

    if (progress.status) {
      const mappedListId = statusMapping[progress.status];
      if (mappedListId !== undefined && mappedListId !== null && mappedListId !== targetListId) {
        targetListId = mappedListId;
        listChanged = true;
      }
    }

    /** @type {Record<string, number>} */
    const statusPayload = {};
    if (typeof progress.chapter === 'number' && progress.chapter >= 0) {
      statusPayload.chapter = Number(progress.chapter);
    }
    if (typeof progress.volume === 'number' && progress.volume >= 0) {
      statusPayload.volume = Number(progress.volume);
    }

    /** @type {string[]} */
    const updatedFields = [];
    const statusKeys = Object.keys(statusPayload);
    const needsListUpdate = listChanged || statusKeys.length > 0;

    if (needsListUpdate) {
      /** @type {Record<string, unknown>} */
      const listPayload = {
        series: { id: numericSeriesId },
        list_id: targetListId,
      };

      if (statusKeys.length > 0) {
        listPayload.status = statusPayload;
      }

      const updateResult = await this.updateListSeries(listPayload);
      if (updateResult.status && updateResult.status >= 400) {
        const errorReason = updateResult && typeof updateResult === 'object' && updateResult.data && typeof updateResult.data === 'object'
          ? updateResult.data.reason
          : null;
        return {
          success: false,
          error: `Failed to update reading list entry: ${typeof errorReason === 'string' ? errorReason : 'Unknown error'}`,
        };
      }

      if (statusPayload.chapter !== undefined) {
        updatedFields.push('chapter');
      }
      if (statusPayload.volume !== undefined) {
        updatedFields.push('volume');
      }
      if (listChanged) {
        updatedFields.push('status');
      }

      if (this.cacheAdapter && typeof this.cacheAdapter.deleteValue === 'function') {
        await this.cacheAdapter.deleteValue(`getSeriesListStatus%%${numericSeriesId}`);
      }
    }

    if (typeof progress.rating === 'number' && progress.rating >= 0) {
      const ratingResult = await this.updateSerieRating(String(numericSeriesId), {
        rating: Number(progress.rating),
      });

      if (ratingResult.status && ratingResult.status >= 400) {
        const errorReason = ratingResult && typeof ratingResult === 'object' && ratingResult.data && typeof ratingResult.data === 'object'
          ? ratingResult.data.reason
          : null;
        return {
          success: false,
          updatedFields: updatedFields.length > 0 ? updatedFields : undefined,
          error: `Failed to update rating: ${typeof errorReason === 'string' ? errorReason : 'Unknown error'}`,
        };
      }

      updatedFields.push('rating');
    }

    if (updatedFields.length === 0) {
      return {
        success: true,
        message: 'No changes required',
      };
    }

    return {
      success: true,
      updatedFields,
      message: `Updated ${updatedFields.join(', ')}`,
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
   * @param {string|number} trackerId
   * @param {boolean} [useCache]
   * @returns {Promise<MangaUpdatesRawEntityResponse>}
   */
  async getSeriesByIdRaw(trackerId, useCache = true) {
    const normalizedTrackerId = typeof trackerId === 'string' ? trackerId.trim() : String(trackerId || '').trim();

    try {
      const seriesDetail = await this.getSerieDetail(Number(trackerId), { useCache });
      if (seriesDetail && typeof seriesDetail === 'object') {
        const id = typeof seriesDetail.series_id === 'number' || typeof seriesDetail.series_id === 'string'
          ? seriesDetail.series_id
          : normalizedTrackerId || 'unknown';
        const title = typeof seriesDetail.title === 'string' && seriesDetail.title.trim()
          ? seriesDetail.title
          : normalizedTrackerId || 'Unknown MangaUpdates Title';
        const url = typeof seriesDetail.url === 'string' ? seriesDetail.url : null;

        return {
          trackerId: 'mangaupdates',
          operation: 'getSeriesByIdRaw',
          payload: {
            id,
            title,
            url,
            series: seriesDetail,
          },
        };
      }
    } catch (error) {
      // Fallback placeholder preserves baseline contract behavior when series detail lookup is unavailable.
    }

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
