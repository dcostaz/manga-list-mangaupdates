'use strict';

const path = require('path');
const MangaUpdatesAPISettings = require(path.join(__dirname, 'api-settings-mangaupdates.cjs'));

const SERVICE_NAME = 'mangaupdates';

/** @typedef {import('../../../../types/plugintypedefs').PluginServiceSettings} PluginServiceSettings */
/** @typedef {import('../../../../types/plugintypedefs').PluginCredential} PluginCredential */
/** @typedef {import('../../../../types/plugintypedefs').PluginReadingStatus} PluginReadingStatus */
/** @typedef {import('../../../../types/plugintypedefs').PluginProgressDTO} PluginProgressDTO */
/** @typedef {import('../../../../types/plugintypedefs').PluginProgressComparisonResult} PluginProgressComparisonResult */
/** @typedef {import('../../../../types/plugintypedefs').PluginSearchResult} PluginSearchResult */
/** @typedef {import('../../../../types/plugintypedefs').PluginInitResult} PluginInitResult */
/** @typedef {import('../../../../types/plugintypedefs').PluginStatus} PluginStatus */
/** @typedef {import('../../../../types/plugincontexttypedefs').PluginContextLike} PluginContextLike */

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
 * @param {string[]} expectedTitles
 * @param {string[]} candidateTitles
 * @returns {{ hasExactMatch: boolean, bestSimilarity: number }}
 */
function calculateTitleSimilarity(expectedTitles, candidateTitles, containmentScore = 0.85) {
  let hasExactMatch = false;
  let bestSimilarity = 0;

  for (const expectedTitle of expectedTitles) {
    if (typeof expectedTitle !== 'string') {
      continue;
    }

    const expectedSlug = toSlug(expectedTitle);
    if (!expectedSlug) {
      continue;
    }

    for (const candidateTitle of candidateTitles) {
      if (typeof candidateTitle !== 'string') {
        continue;
      }

      const candidateSlug = toSlug(candidateTitle);
      if (!candidateSlug) {
        continue;
      }

      if (candidateSlug === expectedSlug) {
        hasExactMatch = true;
        bestSimilarity = 1;
        continue;
      }

      let similarity = 0;
      if (candidateSlug.includes(expectedSlug) || expectedSlug.includes(candidateSlug)) {
        similarity = containmentScore;
      } else {
        const expectedTokens = expectedSlug.split('-').filter(Boolean);
        const candidateTokens = candidateSlug.split('-').filter(Boolean);
        const expectedSet = new Set(expectedTokens);
        const candidateSet = new Set(candidateTokens);
        const intersection = [...expectedSet].filter((token) => candidateSet.has(token)).length;
        const union = new Set([...expectedSet, ...candidateSet]).size;
        if (union > 0) {
          similarity = intersection / union;
        }
      }

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
      }
    }
  }

  return {
    hasExactMatch,
    bestSimilarity,
  };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // In the plugin runtime (~/plugins/runtime/...) there is no local node_modules,
    // so require('axios') fails; fall back to the host app via require.main.
    let axiosModule = null;
    try {
      axiosModule = require('axios');
    } catch (err) {
      if (require.main && typeof require.main.require === 'function') {
        axiosModule = require.main.require('axios');
      } else {
        throw err;
      }
    }
    const axios = axiosModule && axiosModule.default ? axiosModule.default : axiosModule;
    if (axios && typeof axios.create === 'function') {
      return axios.create();
    }
  } catch (error) {
    // Fallback is used when axios cannot be resolved in this runtime environment.
  }

  return createFallbackHttpClient();
}

class MangaUpdatesAPIWrapper {
  /**
   * @param {object} [params]
   * @param {MangaUpdatesAPISettings | null} [params.apiSettings]
   * @param {PluginServiceSettings} [params.serviceSettings]
   * @param {PluginContextLike | null} [params.context]
   */
  constructor(params = {}) {
    const apiSettings = params && typeof params === 'object' ? params.apiSettings : null;
    const serviceSettings = params && typeof params === 'object' ? params.serviceSettings : null;
    const providedContext = params && typeof params === 'object' ? params.context : null;
    const providedHttpClient = params && typeof params === 'object' ? params.httpClient : null;

    this.settings = serviceSettings && typeof serviceSettings === 'object'
      ? serviceSettings
      : {};
    this.apiSettings = apiSettings instanceof MangaUpdatesAPISettings ? apiSettings : null;
    this._context = providedContext && typeof providedContext === 'object' ? providedContext : null;
    this.bearerToken = null;
    this._defaultTokenName = 'session_token';
    this.credentials = null;
    this._initialized = false;
    // axios.create() returns a callable function (it supports both instance(config)
    // and instance.get(url)), so typeof is 'function', not 'object' — accept both.
    this.httpClient = providedHttpClient && (typeof providedHttpClient === 'object' || typeof providedHttpClient === 'function')
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
   * @param {object} [options]
   * @param {MangaUpdatesAPISettings | null} [options.apiSettings]
   * @param {PluginServiceSettings} [options.serviceSettings]
   * @param {PluginContextLike | null} [options.context]
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

    const context = options && typeof options === 'object' ? (options.context || null) : null;
    // axios.create() returns a callable function, so typeof is 'function', not 'object'.
    const directHttpClient = options && typeof options === 'object' && options.httpClient
      && (typeof options.httpClient === 'object' || typeof options.httpClient === 'function')
      ? options.httpClient
      : null;
    const httpClientFactory = options && typeof options === 'object' && typeof options.httpClientFactory === 'function'
      ? options.httpClientFactory
      : null;
    const httpClientFromFactory = !directHttpClient && httpClientFactory ? httpClientFactory() : null;

    return new MangaUpdatesAPIWrapper({
      apiSettings,
      serviceSettings,
      context,
      httpClient: directHttpClient || httpClientFromFactory || null,
    });
  }

  /**
   * @returns {string}
   */
  static get serviceName() {
    return SERVICE_NAME;
  }

  static get pluginName() { return SERVICE_NAME; }

  /** @returns {string} */
  get pluginName() { return SERVICE_NAME; }

  /** @returns {string[]} */
  get pluginType() { return Object.freeze(['tracker']); }

  /** @returns {string[]} */
  get capabilities() { return Object.freeze(['tracker.search', 'tracker.sync', 'tracker.cover', 'localtracker.enrich', 'plugin.live']); }

  /** Credential fields the host renders in the plugin credential form. */
  get credentialSchema() {
    return Object.freeze([
      { key: 'username', label: 'Username', type: 'text' },
      { key: 'password', label: 'Password', type: 'password' },
    ]);
  }

  /** @returns {string} */
  get contractVersion() {
    const { PLUGIN_CONTRACT_VERSION } = require(path.join(__dirname, '..', 'plugindtocontract.cjs'));
    return PLUGIN_CONTRACT_VERSION;
  }

  /**
   * @returns {Promise<PluginInitResult>}
   */
  async initialize() {
    this._initialized = true;
    return { status: 'ok' };
  }

  /**
   * @returns {PluginStatus}
   */
  getStatus() {
    return { status: this._initialized ? 'ok' : 'initializing' };
  }

  /**
   * @param {PluginCredential} current
   * @returns {Promise<PluginCredential>}
   */
  async refreshCredentials(current) {
    if (!current || typeof current !== 'object') {
      throw new Error('(refreshCredentials) current credential is required');
    }
    const credentials = { username: current.username || '', password: current.password || '' };
    const tokenData = await this._fetchNewToken(credentials, { forceRefresh: true });
    const token = await this._extractToken(tokenData);
    return {
      token: token || '',
      refreshToken: current.refreshToken || null,
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    };
  }

  /**
   * @param {string} query
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async search(query) {
    const q = typeof query === 'string' ? query : '';
    if (!q.trim()) return [];
    return this.searchTrackers(q, {});
  }

  /**
   * @param {string|number} pluginEntryId
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async pullProgress(pluginEntryId) {
    return this.getUserProgress(pluginEntryId);
  }

  /**
   * host-capability-contract.md §2's sync.push mapping — one entry's worth of the array-shaped
   * pushProgress() below. Status is no longer accepted here — moved to subscribe.add's own
   * subscribe() under the new contract (host-capability-contract.md §5.1: status is a
   * Subscribing-domain fact, not a Syncing one).
   * @param {string|number} pluginEntryId
   * @param {{ chapter?: number, volume?: number, rating?: number }} [progress]
   * @returns {Promise<{ pluginEntryId: string, success: boolean, updatedFields?: string[], message?: string, error?: string }>}
   * @private
   */
  async _pushProgressOne(pluginEntryId, progress = {}) {
    try {
      const result = await this.setUserProgress(pluginEntryId, progress);
      return { pluginEntryId: String(pluginEntryId), ...result };
    } catch (error) {
      return { pluginEntryId: String(pluginEntryId), success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * host-capability-contract.md §2.1 — sync.push's array-shaped pushProgress(). Called on every
   * relevant Bookmark chapter/volume/rating edit, never carrying status (that's pushStatus's own
   * job under the new contract). MangaUpdates' remote API is per-series only, so the array shape is
   * realized by looping internally. Array in, array out, per-entry failure — never a whole-batch
   * throw.
   * @param {Array<{ pluginEntryId: string, chapter?: number, volume?: number, rating?: number }>} entries
   * @returns {Promise<Array<{ pluginEntryId: string, success: boolean, updatedFields?: string[], message?: string, error?: string }>>}
   */
  async pushProgress(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const results = [];
    for (const entry of list) {
      results.push(await this._pushProgressOne(entry && entry.pluginEntryId, entry ? {
        chapter: entry.chapter,
        volume: entry.volume,
        rating: entry.rating,
      } : {}));
    }
    return results;
  }

  /**
   * Compare the host's known progress (e.g. a Bookmark) against this
   * source's own freshly-fetched progress, owning every precision quirk
   * MangaUpdates itself has so the host never needs source-specific
   * exception logic (owner correction 2026-07-23).
   *
   * Chapter: MangaUpdates' reading-list chapter field is integer-only —
   * confirmed against the real OpenAPI spec (`ListsSeriesModelV1Status.
   * chapter` and `ListsSeriesModelUpdateV1.status.chapter` are both
   * `type: integer`), and against live data (0/1972 fractional chapters
   * across a real account's full reading list). A host chapter with a
   * fractional part (e.g. 45.5 for a half/extra chapter) must be compared
   * on its integer part only, or a fractional-vs-truncated mismatch reads
   * as a false "ahead"/"behind" — the accepted limitation is to use just
   * the integer part.
   *
   * Rating: both sides are float-capable here (MangaUpdates' own rating
   * type has no documented integer constraint, unlike MangaDex), so a
   * direct equality check is safe — no rounding needed.
   *
   * Field name note (found 2026-07-23): reads `.status`, not
   * `PluginProgressDTO`'s declared `.readingStatus` — every real
   * progress-carrying object this wrapper produces or accepts
   * (`pullProgress`/`getUserProgress`'s return, `pushProgress`/
   * `setUserProgress`'s input, `getReadingList()`'s entries) already uses
   * `.status`; `readingStatus` is only real on the separate
   * `PluginSubscribeContext` type (`subscribe()`'s own param). Matching the
   * typedef literally here would have made statusDiffers silently never
   * fire against real data.
   * @param {{ status?: string | null, chapter?: number | null, rating?: number | null }} hostProgress
   * @param {{ status?: string | null, chapter?: number | null, rating?: number | null }} remoteProgress
   * @returns {PluginProgressComparisonResult}
   */
  compareProgress(hostProgress, remoteProgress) {
    const hp = hostProgress && typeof hostProgress === 'object' ? hostProgress : {};
    const rp = remoteProgress && typeof remoteProgress === 'object' ? remoteProgress : {};

    /** @type {boolean | null} */
    let chapterAhead = null;
    /** @type {boolean | null} */
    let chapterBehindOrEqual = null;
    if (typeof hp.chapter === 'number' && typeof rp.chapter === 'number') {
      const hostWhole = Math.floor(hp.chapter);
      const remoteWhole = Math.floor(rp.chapter);
      chapterAhead = remoteWhole > hostWhole;
      chapterBehindOrEqual = remoteWhole <= hostWhole;
    }

    /** @type {boolean | null} */
    let ratingDiffers = null;
    if (typeof hp.rating === 'number' || typeof rp.rating === 'number') {
      ratingDiffers = (hp.rating ?? null) !== (rp.rating ?? null);
    }

    /** @type {boolean | null} */
    let statusDiffers = null;
    if (typeof hp.status === 'string' || typeof rp.status === 'string') {
      statusDiffers = (hp.status ?? null) !== (rp.status ?? null);
    }

    return { chapterAhead, chapterBehindOrEqual, ratingDiffers, statusDiffers };
  }

  /**
   * host-capability-contract.md §2's subscribe.add mapping — one entry's worth of the array-shaped
   * subscribe() below. Reuses the raw API layer's own subscribeToReadingList() (idempotent — it
   * checks the series' existing list membership and updates rather than duplicating).
   * @param {string|number} pluginEntryId
   * @param {{ readingStatus?: string, chapter?: number, volume?: number, rating?: number } | null} [context]
   * @returns {Promise<{ pluginEntryId: string, success: boolean, mode?: 'added'|'updated', listId?: number|null, error?: string }>}
   * @private
   */
  async _subscribeOne(pluginEntryId, context) {
    try {
      const result = await this.subscribeToReadingList({
        seriesId: pluginEntryId,
        status: context && context.readingStatus ? context.readingStatus : null,
        chapter: context && typeof context.chapter === 'number' ? context.chapter : undefined,
        volume: context && typeof context.volume === 'number' ? context.volume : undefined,
        rating: context && typeof context.rating === 'number' ? context.rating : undefined,
      });
      return { pluginEntryId: String(pluginEntryId), ...result };
    } catch (error) {
      return { pluginEntryId: String(pluginEntryId), success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * host-capability-contract.md §2.1 — subscribe.add's array-shaped subscribe(). Called on every
   * relevant Bookmark status edit under the new contract, not just the initial subscription (status
   * is a Subscribing-domain fact — §5.1 — not bundled into sync.push's pushProgress anymore).
   * MangaUpdates' list endpoints are per-series only, so the array shape is realized by looping
   * internally. Array in, array out, per-entry failure — never a whole-batch throw.
   * @param {Array<{ pluginEntryId: string, status?: string, chapter?: number, volume?: number, rating?: number }>} entries
   * @returns {Promise<Array<{ pluginEntryId: string, success: boolean, mode?: 'added'|'updated', listId?: number|null, error?: string }>>}
   */
  async subscribe(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const results = [];
    for (const entry of list) {
      results.push(await this._subscribeOne(entry && entry.pluginEntryId, entry ? {
        readingStatus: entry.status,
        chapter: entry.chapter,
        volume: entry.volume,
        rating: entry.rating,
      } : null));
    }
    return results;
  }

  /**
   * @returns {Promise<PluginCredential | null>}
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

    const cache = this._context && this._context.cache;
    if (!forceRefresh && cache) {
      const cached = await cache.getValue(cacheKey, { userScoped: true });
      if (cached) {
        this.bearerToken = cached;
        return cached;
      }
    }

    const credentials = await this.getCredentials();
    if (!credentials) {
      throw new Error('Credentials not found.');
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
    const cache = this._context && this._context.cache;
    if (!cache) {
      return Boolean(value);
    }

    if (typeof value === 'undefined') {
      const stored = await cache.getValue('refresh', { userScoped: true });
      return parseBoolean(stored);
    }

    await cache.setValue('refresh', String(Boolean(value)), undefined, { userScoped: true });
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
   * @param {string} key
   * @param {{ userScoped?: boolean }} [options]
   * @returns {Promise<unknown | null>}
   */
  async _getJSONCacheValue(key, options = {}) {
    const cache = this._context && this._context.cache;
    if (!cache || typeof cache.getValue !== 'function') {
      return null;
    }

    const raw = await cache.getValue(key, options);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
  }

  /**
   * @param {string} key
   * @param {unknown} value
   * @param {number} ttlSeconds
   * @param {{ userScoped?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async _setJSONCacheValue(key, value, ttlSeconds, options = {}) {
    const cache = this._context && this._context.cache;
    if (!cache || typeof cache.setValue !== 'function') {
      return;
    }

    await cache.setValue(key, JSON.stringify(value), ttlSeconds, options);
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
    const cache = this._context && this._context.cache;
    if (!forceRefresh && cache) {
      const cachedToken = await cache.getValue(cacheKey, { userScoped: true });
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

    let response;
    try {
      response = await this.httpClient.put(
        endpoint,
        requestPayload,
        { headers: { 'Content-Type': 'application/json' } },
      );
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[mangaupdates] _fetchNewToken: login request to ${endpoint} failed${code ? ` (${code})` : ''}:`, detail);
      throw error;
    }
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
    const cache = this._context && this._context.cache;
    if (!token || !cache) {
      return;
    }

    const cacheKey = this._getTokenCacheKey();
    const ttl = this._getTokenTTL('session_token');
    await cache.setValue(cacheKey, token, ttl, { userScoped: true });
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
    if (!refreshRequired) {
      const cached = await this._getJSONCacheValue(cacheKey, { userScoped: true });
      if (Array.isArray(cached)) {
        return cached;
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

    await this._setJSONCacheValue(cacheKey, lists, 3600, { userScoped: true });

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
    if (!refreshRequired) {
      const cached = await this._getJSONCacheValue(cacheKey, { userScoped: true });
      if (cached && typeof cached === 'object') {
        return /** @type {Record<string, unknown>} */ (cached);
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

      if (payload) {
        await this._setJSONCacheValue(cacheKey, payload, 3600, { userScoped: true });
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
   * Fetch every series entry in one MangaUpdates list (paginated). Ports the
   * pre-UPS `getListSeries()` implementation's endpoint/pagination/throttle
   * behavior (`D:\test\cls\mangaupdates.cjs:407-523`) onto this wrapper's
   * httpClient/cache/settings conventions (the raw axios/Redis calls that
   * implementation used are gone; the endpoint, pagination, and throttle
   * logic are unchanged). `list_id` is per-account (from `getUserLists()`),
   * not a fixed global id — the `/lists/{id}/search` endpoint has no
   * "every list" form (Investigation §6, `Plan-2026Q3-uniform-plugin-card-badges.md`).
   * @param {number} listId
   * @param {{ useCache?: boolean }} [options]
   * @returns {Promise<MangaUpdatesReadingListSearchResultsEntry[]>}
   */
  async getListSeries(listId, options = {}) {
    const numericListId = Number(listId);
    if (!Number.isFinite(numericListId)) {
      return [];
    }

    const useCache = !(options && typeof options === 'object' && options.useCache === false);
    const cacheKey = `getListSeries%%${numericListId}`;
    const refreshRequired = await this.refresh();
    if (!refreshRequired && useCache) {
      const cached = await this._getJSONCacheValue(cacheKey, { userScoped: true });
      if (Array.isArray(cached)) {
        return cached;
      }
    }

    const bearerToken = await this.getToken();
    if (!bearerToken) {
      return [];
    }

    const endpoint = this._resolveEndpoint('api.endpoints.listSearch.template', { list_id: numericListId });
    if (!endpoint) {
      throw new Error('(getListSeries) Missing listSearch config');
    }

    if (!this.httpClient || typeof this.httpClient.post !== 'function') {
      throw new Error('(getListSeries) HTTP client post method is not configured');
    }

    const perPageSetting = Number(this._resolveSettingValue('api.endpoints.listSearch.perPage'));
    const perPage = Number.isFinite(perPageSetting) && perPageSetting > 0 ? perPageSetting : 20;
    const throttleSetting = Number(this._resolveSettingValue('api.endpoints.listSearch.throttle'));
    const throttleMs = Number.isFinite(throttleSetting) && throttleSetting >= 0 ? throttleSetting : 500;

    /** @type {MangaUpdatesReadingListSearchResultsEntry[]} */
    const entries = [];
    let page = 1;
    while (true) {
      const response = await this.httpClient.post(
        endpoint,
        { page, perpage: perPage },
        { headers: { Authorization: `Bearer ${bearerToken}`, 'Content-Type': 'application/json' } },
      );
      const responseData = response && typeof response === 'object' ? response.data : null;
      const results = responseData && typeof responseData === 'object' && Array.isArray(responseData.results)
        ? responseData.results
        : [];

      if (results.length === 0) {
        break;
      }

      entries.push(...results);

      if (results.length < perPage) {
        break;
      }

      page += 1;
      await wait(throttleMs);
    }

    if (entries.length > 0) {
      await this._setJSONCacheValue(cacheKey, entries, 3600, { userScoped: true });
    }
    if (refreshRequired) {
      await this.refresh(false);
    }

    return entries;
  }

  /**
   * Bulk-fetch every entry across every one of the user's MangaUpdates lists —
   * the plugin-side half of `Plan-2026Q3-plugin-sync-management-modal.md`
   * Phase 12's `getReadingList()`. One `getListSeries()` call per list_id
   * `getUserLists()` reports, throttled between lists (no bulk "every list"
   * endpoint exists). Each entry is tagged with the resolved status of the
   * list it came from — `getReadingStatusFromListId()` already does this
   * mapping once per list rather than guessing per entry. `rating` comes
   * from the same entry's sibling `metadata.user_rating` field (owner
   * correction, 2026-07-23: an earlier pass here only read the `record`
   * half of each entry and missed it — verified live against a real
   * account, `metadata.user_rating` is present per entry, `null` — the
   * API's own sentinel, not a guessed default — when the user hasn't rated
   * that series). No extra call needed, unlike MangaDex's separate
   * `/rating` endpoint.
   *
   * Optional `hostProgressByEntryId` (owner direction, 2026-07-23): when
   * supplied, each returned entry also carries a `comparison` — the same
   * `compareProgress()` this wrapper already exposes standalone, run once
   * per entry against the host's own known progress for that reference, so
   * a bulk pull-review consumer gets classification (chapter-ahead,
   * rating-differs, status-differs) for free from the one call instead of
   * looping `compareProgress()` itself. No extra network cost — comparison
   * is pure computation over data this call already fetched.
   * @param {{ useCache?: boolean, hostProgressByEntryId?: Map<string, { status?: string | null, chapter?: number | null, rating?: number | null }> }} [options]
   * @returns {Promise<Array<{
   *   pluginEntryId: string,
   *   title: string | null,
   *   canonicalUrl: string | null,
   *   status: string,
   *   rating: number | null,
   *   chapter: number | null,
   *   volume: number | null,
   *   listId: number,
   *   priority: number | null,
   *   lastUpdated: string | null,
   *   comparison: PluginProgressComparisonResult | null
   * }>>}
   */
  async getReadingList(options = {}) {
    const userLists = await this.getUserLists();
    if (!Array.isArray(userLists) || userLists.length === 0) {
      return [];
    }

    const throttleSetting = Number(this._resolveSettingValue('api.endpoints.listSearch.throttle'));
    const throttleMs = Number.isFinite(throttleSetting) && throttleSetting >= 0 ? throttleSetting : 500;

    /** @type {Array<Record<string, unknown>>} */
    const normalized = [];
    let isFirstList = true;
    for (const list of userLists) {
      const listId = list && typeof list === 'object' && typeof list.list_id === 'number' ? list.list_id : null;
      if (listId === null) {
        continue;
      }

      if (!isFirstList) {
        await wait(throttleMs);
      }
      isFirstList = false;

      const status = await this.getReadingStatusFromListId(listId);
      const entries = await this.getListSeries(listId, options);

      for (const entry of entries) {
        const record = entry && typeof entry === 'object' && entry.record && typeof entry.record === 'object'
          ? entry.record
          : null;
        if (!record) {
          continue;
        }

        const series = record.series && typeof record.series === 'object' ? record.series : {};
        const statusInfo = record.status && typeof record.status === 'object' ? record.status : {};
        const timeAdded = record.time_added && typeof record.time_added === 'object' ? record.time_added : null;
        const metadata = entry && typeof entry === 'object' && entry.metadata && typeof entry.metadata === 'object'
          ? entry.metadata
          : null;

        if (typeof series.id === 'undefined' || series.id === null) {
          continue;
        }

        normalized.push({
          pluginEntryId: String(series.id),
          title: typeof series.title === 'string' ? series.title : null,
          canonicalUrl: typeof series.url === 'string' ? series.url : null,
          status,
          rating: metadata && typeof metadata.user_rating === 'number' ? metadata.user_rating : null,
          chapter: typeof statusInfo.chapter === 'number' ? statusInfo.chapter : null,
          volume: typeof statusInfo.volume === 'number' ? statusInfo.volume : null,
          listId,
          priority: typeof record.priority === 'number' ? record.priority : null,
          lastUpdated: timeAdded && typeof timeAdded.timestamp === 'number'
            ? new Date(timeAdded.timestamp * 1000).toISOString()
            : null,
          comparison: /** @type {PluginProgressComparisonResult | null} */ (null),
        });
      }
    }

    const hostProgressByEntryId = options && options.hostProgressByEntryId instanceof Map
      ? options.hostProgressByEntryId
      : null;
    if (hostProgressByEntryId) {
      for (const entry of normalized) {
        const hostProgress = hostProgressByEntryId.get(entry.pluginEntryId);
        if (hostProgress) {
          entry.comparison = this.compareProgress(hostProgress, entry);
        }
      }
    }

    return normalized;
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

    // Owner correction 2026-07-23: pullProgress() must carry rating in line
    // with getReadingList()'s bulk fetch — the single-item endpoint has no
    // metadata sibling to read it from for free, so it's a real extra call.
    // A rating-fetch failure (missing config, transient network error) must
    // not fail the whole pull over a supplementary field — chapter/volume/
    // status are the primary payload, matching getReadingStatusFromListId's
    // own degrade-rather-than-throw precedent in this file.
    try {
      const rating = await this.getSerieRating(seriesId);
      if (typeof rating === 'number') {
        progress.rating = rating;
      }
    } catch (error) {
      console.warn(`[mangaupdates] getUserProgress(${seriesId}): rating fetch failed, continuing without it:`, error instanceof Error ? error.message : error);
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
    if (!refreshRequired) {
      const cached = await this._getJSONCacheValue(cacheKey);
      if (cached && typeof cached === 'object') {
        return /** @type {Record<string, unknown>} */ (cached);
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
      console.error(`[mangaupdates] getSerieDetail(${numericId}): getToken() returned empty — not authenticated, series lookup skipped.`);
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
      const cache = this._context && this._context.cache;
      if (payload && cache) {
        const ttlCandidate = this._resolveSettingValue('cache.ttl.seriesMetadata');
        const ttl = typeof ttlCandidate === 'number' && Number.isFinite(ttlCandidate) && ttlCandidate > 0
          ? ttlCandidate
          : 24 * 60 * 60;
        await this._setJSONCacheValue(cacheKey, payload, ttl);
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
          .map((entry) => (entry && typeof entry === 'object' && typeof entry.name === 'string'
            ? { name: entry.name, type: typeof entry.type === 'string' ? entry.type : undefined }
            : null))
          .filter((entry) => entry !== null),
        publishers: publishers
          .map((entry) => (entry && typeof entry === 'object' && typeof entry.publisher_name === 'string'
            ? { name: entry.publisher_name, type: typeof entry.type === 'string' ? entry.type : undefined }
            : null))
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
      // Real failures (network/TLS/auth) must propagate so the host surfaces the
      // actual cause instead of a generic "no contribution" message; only an
      // explicit null seriesDetail (not-found/not-authenticated) means "no data".
      console.error(`[mangaupdates] getSeriesById(${trackerId}) failed:`, error instanceof Error ? error.message : error);
      throw error;
    }
  }

  // ── plugin.live ──

  /**
   * @param {string} pluginEntryId
   * @returns {Promise<import('../../../../types/plugintypedefs').PluginLiveQueryResult>}
   */
  async queryLive(pluginEntryId) {
    let series;
    try {
      series = await this.getSeriesById(pluginEntryId, false);
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error), retryable: true };
    }
    if (!series) return { status: 'not_found' };

    const md = series.metadata && typeof series.metadata === 'object' ? series.metadata : {};
    let seriesUrl = null;
    try { seriesUrl = await this.getSeriesUrl(pluginEntryId); } catch { seriesUrl = null; }

    return {
      status: 'ok',
      data: {
        pluginEntryId: String(pluginEntryId),
        displayTitle: typeof series.title === 'string' ? series.title : undefined,
        linkState: 'active',
        statusLabel: typeof md.status === 'string' ? md.status : undefined,
        fetchedAt: new Date().toISOString(),
        sections: [
          {
            type: 'stat-grid',
            label: 'Overview',
            fields: {
              'Series status': typeof md.status === 'string' ? md.status : '—',
              'Type': typeof md.type === 'string' ? md.type : '—',
              'Year': typeof md.year === 'number' ? md.year : '—',
              'Alt titles': Array.isArray(series.alternativeTitles) ? series.alternativeTitles.length : 0,
            },
          },
          ...(seriesUrl ? [{
            type: 'link-list',
            label: 'Links',
            links: [{ label: 'MangaUpdates', url: seriesUrl }],
          }] : []),
        ],
      },
    };
  }

  // ── localtracker.enrich (MangaUpdates enriches localtracker metadata from its API) ──

  /**
   * Map a MangaUpdates status string to the PluginLinkContribution seriesStatus enum.
   * @param {unknown} status
   * @returns {'ongoing' | 'completed' | 'hiatus' | 'unknown'}
   */
  _mapSeriesStatus(status) {
    const s = typeof status === 'string' ? status.toLowerCase() : '';
    if (s.includes('complete')) return 'completed';
    if (s.includes('hiatus')) return 'hiatus';
    if (s.includes('ongoing') || s.includes('publish')) return 'ongoing';
    return 'unknown';
  }

  /**
   * Build a PluginLinkContribution for a linked MangaUpdates series. Re-fetches
   * stable metadata (cover, titles, authors, genres, status) from the series
   * detail endpoint and the canonical series URL.
   * @param {string} pluginEntryId - MangaUpdates series id
   * @returns {Promise<import('../../../../types/plugintypedefs').PluginLinkContribution | null>}
   */
  async buildLinkContribution(pluginEntryId) {
    const series = await this.getSeriesById(pluginEntryId, true);
    if (!series) return null;
    const md = series.metadata && typeof series.metadata === 'object' ? series.metadata : {};

    let seriesUrl = null;
    try { seriesUrl = await this.getSeriesUrl(pluginEntryId); } catch { seriesUrl = null; }

    /** @type {import('../../../../types/plugintypedefs').PluginLinkContribution} */
    const contribution = {
      pluginEntryId: String(pluginEntryId),
      syncedAt: new Date().toISOString(),
      seriesStatus: this._mapSeriesStatus(md.status),
    };
    if (series.title) contribution.displayTitle = series.title;
    if (Array.isArray(series.alternativeTitles) && series.alternativeTitles.length) contribution.altTitles = series.alternativeTitles;
    if (Array.isArray(md.authors) && md.authors.length) contribution.authors = md.authors;
    if (Array.isArray(md.genres) && md.genres.length) contribution.genres = md.genres;
    if (md.description) contribution.description = md.description;
    if (series.coverUrl) contribution.coverUrl = series.coverUrl;
    if (typeof md.year === 'number' && Number.isFinite(md.year)) contribution.year = md.year;
    if (typeof md.type === 'string' && md.type) contribution.seriesType = md.type;
    if (Array.isArray(md.publishers) && md.publishers.length) contribution.publishers = md.publishers;
    contribution.sourceLinks = seriesUrl
      ? [{ siteId: SERVICE_NAME, siteLabel: 'MangaUpdates', seriesUrl, isPrimary: true }]
      : [];
    return contribution;
  }

  /**
   * Same enrichment as buildLinkContribution, resolving the series id from the
   * supplied LocalTrackerEntry (host passes the linked pluginEntryId).
   * @param {{ pluginEntryId?: string, plugin_entry_id?: string }} localTrackerEntry
   * @returns {Promise<import('../../../../types/plugintypedefs').PluginLinkContribution | null>}
   */
  async syncEnrichment(localTrackerEntry) {
    const entry = localTrackerEntry && typeof localTrackerEntry === 'object' ? localTrackerEntry : {};
    const pluginEntryId = entry.pluginEntryId || entry.plugin_entry_id || null;
    if (!pluginEntryId) return null;
    return this.buildLinkContribution(pluginEntryId);
  }

  /**
   * host-capability-contract.md §2.1 — enrich's array-shaped dispatch. Loops over the existing
   * single-entry buildLinkContribution() (kept unchanged, still used directly by syncEnrichment()) —
   * no bulk MangaUpdates endpoint exists for this. Array in, array out, per-entry failure — never a
   * whole-batch throw. A null contribution (entry not found remotely) is reported as a failure, not
   * a silent success with no data.
   * @param {string[]} pluginEntryIds
   * @returns {Promise<Array<{ pluginEntryId: string, success: boolean, contribution?: import('../../../../types/plugintypedefs').PluginLinkContribution, error?: string }>>}
   */
  async enrich(pluginEntryIds) {
    const ids = Array.isArray(pluginEntryIds) ? pluginEntryIds : [];
    const results = [];
    for (const id of ids) {
      try {
        const contribution = await this.buildLinkContribution(id);
        if (contribution) {
          results.push({ pluginEntryId: String(id), success: true, contribution });
        } else {
          results.push({ pluginEntryId: String(id), success: false, error: 'No contribution available for this id' });
        }
      } catch (error) {
        results.push({ pluginEntryId: String(id), success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
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
    const searchKeyStr = this._context && this._context.utils
      ? this._context.utils.sanitizeForSearch(payload.search)
      : toSlug(payload.search);
    const cacheKey = `serieSearch%%${searchKeyStr}%%${perpage}`;

    const refreshRequired = await this.refresh();
    if (!refreshRequired && useCache) {
      const cached = await this._getJSONCacheValue(cacheKey);
      if (Array.isArray(cached)) {
        return cached;
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

    if (results.length > 0) {
      const ttlCandidate = this._resolveSettingValue('cache.ttl.searchResults');
      const ttl = typeof ttlCandidate === 'number' && Number.isFinite(ttlCandidate) && ttlCandidate > 0
        ? ttlCandidate
        : 3600;
      await this._setJSONCacheValue(cacheKey, results, ttl);
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

      const cacheForDelete = this._context && this._context.cache;
      if (cacheForDelete && typeof cacheForDelete.deleteValue === 'function') {
        await cacheForDelete.deleteValue(`getSerieDetail%%${Number(id)}`);
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

      const cacheForDelete = this._context && this._context.cache;
      if (cacheForDelete && typeof cacheForDelete.deleteValue === 'function') {
        await cacheForDelete.deleteValue(`getSerieDetail%%${Number(id)}`);
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

      const cacheForDelete = this._context && this._context.cache;
      if (cacheForDelete && typeof cacheForDelete.deleteValue === 'function') {
        await cacheForDelete.deleteValue(`getSerieDetail%%${Number(id)}`);
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
   * Read the caller's own rating for one series via `GET /series/{id}/rating`
   * — the read counterpart of `updateSerieRating()`, same endpoint, verified
   * live 2026-07-23 against a real account: `{rating, last_updated}` on 200
   * when rated, a plain 404 when not (mirrors `getSeriesListStatus()`'s own
   * 404-means-absent handling). Used by `getUserProgress()` to bring the
   * single-entry pull path in line with `getReadingList()`'s bulk rating
   * data (that one gets it for free from the list-search response's sibling
   * `metadata.user_rating`; this single-item endpoint has no such sibling,
   * confirmed live, so it needs its own call).
   * @param {string|number} id
   * @returns {Promise<number | null>}
   */
  async getSerieRating(id) {
    let bearerToken = '';
    try {
      bearerToken = await this.getToken();
    } catch (error) {
      bearerToken = '';
    }

    if (!bearerToken) {
      return null;
    }

    const endpoint = this._resolveEndpoint('api.endpoints.updateSerieRating.template', {
      series_id: id,
    });
    if (!endpoint) {
      throw new Error('(getSerieRating) Missing updateSerieRating config');
    }

    if (!this.httpClient || typeof this.httpClient.get !== 'function') {
      throw new Error('(getSerieRating) HTTP client get method is not configured');
    }

    try {
      const response = await this.httpClient.get(endpoint, {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'Content-Type': 'application/json',
        },
      });

      const payload = response && typeof response === 'object' ? response.data : null;
      return payload && typeof payload === 'object' && typeof payload.rating === 'number'
        ? payload.rating
        : null;
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
   * Clear the caller's own rating for a series via `DELETE /series/{id}/rating`
   * (docs confirm `deleteUserSeriesRating` on the same path family as
   * `getSerieRating`/`updateSerieRating`). `setUserProgress()` routes here
   * when it receives `rating: 0` — owner correction 2026-07-23: mangalist's
   * own Bookmark scale treats 0 as "rating cleared" (`mangalist.cjs`'s
   * reset-rating flow writes `user_rating: 0`), and while MangaUpdates'
   * own rating type has no documented lower bound the way MangaDex's
   * strict 1-10 does, "delete the rating" is still the correct real-API
   * equivalent of "cleared" — not a literal zero rating.
   * @param {string|number} id
   * @returns {Promise<{ status: number, data: unknown }>}
   */
  async deleteSerieRating(id) {
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
      throw new Error('(deleteSerieRating) Missing updateSerieRating config');
    }

    if (!this.httpClient || typeof this.httpClient.delete !== 'function') {
      throw new Error('(deleteSerieRating) HTTP client delete method is not configured');
    }

    try {
      const response = await this.httpClient.delete(endpoint, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });

      return {
        status: response && typeof response === 'object' && typeof response.status === 'number' ? response.status : 200,
        data: response && typeof response === 'object' ? response.data : null,
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
   * @param {{
   *  seriesId: string|number,
   *  status?: TrackerReadingStatus,
   *  chapter?: number,
   *  volume?: number,
   *  rating?: number,
   * }} subscriptionData
   * @returns {Promise<{ success: boolean, mode: 'added'|'updated', listId: number|null }>}
   */
  async subscribeToReadingList(subscriptionData) {
    if (!subscriptionData || typeof subscriptionData !== 'object') {
      throw new Error('(subscribeToReadingList) subscriptionData is required');
    }

    const numericSeriesId = Number(subscriptionData.seriesId);
    if (!Number.isFinite(numericSeriesId) || numericSeriesId <= 0) {
      throw new Error('(subscribeToReadingList) Invalid seriesId');
    }

    const userLists = await this.getUserLists();
    if (!Array.isArray(userLists) || userLists.length === 0) {
      throw new Error('(subscribeToReadingList) Unable to fetch user lists.');
    }

    let targetListId = null;
    if (subscriptionData.status) {
      const mappedListId = this._resolveSettingValue(`statusMapping.${subscriptionData.status}`);
      if (typeof mappedListId === 'number') {
        targetListId = mappedListId;
      }
    }

    let targetList = targetListId !== null
      ? userLists.find((list) => list && typeof list === 'object' && list.list_id === targetListId)
      : null;

    if (!targetList) {
      targetList = userLists.find((list) => {
        if (!list || typeof list !== 'object') {
          return false;
        }

        return list.title === 'Reading List'
          || list.title === 'reading list'
          || list.type === 'read';
      }) || userLists[0];
    }

    if (!targetList || typeof targetList !== 'object' || typeof targetList.list_id !== 'number') {
      throw new Error('(subscribeToReadingList) Unable to find target reading list.');
    }

    /** @type {Record<string, number>} */
    const statusObject = {};
    if (typeof subscriptionData.chapter === 'number' && subscriptionData.chapter >= 0) {
      statusObject.chapter = Number(subscriptionData.chapter);
    }
    if (typeof subscriptionData.volume === 'number' && subscriptionData.volume >= 0) {
      statusObject.volume = Number(subscriptionData.volume);
    }

    /** @type {Record<string, unknown>} */
    const listSeriesPayload = {
      series: { id: numericSeriesId },
      list_id: targetList.list_id,
    };

    if (Object.keys(statusObject).length > 0) {
      listSeriesPayload.status = statusObject;
    }

    const existingStatus = await this.getSeriesListStatus(numericSeriesId);
    const writeResult = existingStatus
      ? await this.updateListSeries([listSeriesPayload])
      : await this.addListSeries([listSeriesPayload]);

    if (writeResult.status && writeResult.status >= 400) {
      const reason = writeResult && typeof writeResult === 'object' && writeResult.data && typeof writeResult.data === 'object'
        ? writeResult.data.reason
        : null;
      throw new Error(
        existingStatus
          ? `(subscribeToReadingList) Failed to update reading list: ${typeof reason === 'string' ? reason : 'Unknown error'}`
          : `(subscribeToReadingList) Failed to add to reading list: ${typeof reason === 'string' ? reason : 'Unknown error'}`,
      );
    }

    if (typeof subscriptionData.rating === 'number' && subscriptionData.rating > 0) {
      const ratingResult = await this.updateSerieRating(String(numericSeriesId), {
        rating: Number(subscriptionData.rating),
      });

      if (ratingResult.status && ratingResult.status >= 400) {
        // Keep subscription successful even when rating update fails.
      }
    }

    const cacheAfterSubscribe = this._context && this._context.cache;
    if (cacheAfterSubscribe && typeof cacheAfterSubscribe.deleteValue === 'function') {
      await cacheAfterSubscribe.deleteValue(`getSeriesListStatus%%${numericSeriesId}`);
    }

    return {
      success: true,
      mode: existingStatus ? 'updated' : 'added',
      listId: targetList.list_id,
    };
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

    // Status is no longer read here — moved to subscribe()'s own dispatch under the new contract
    // (host-capability-contract.md §5.1: status is a Subscribing-domain fact, not a Syncing one).
    // pushProgress now owns chapter/volume/rating only; the series' current list membership is
    // never changed by this method.
    const targetListId = existingStatus && typeof existingStatus === 'object' && typeof existingStatus.list_id === 'number'
      ? existingStatus.list_id
      : null;

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

    if (statusKeys.length > 0) {
      /** @type {Record<string, unknown>} */
      const listPayload = {
        series: { id: numericSeriesId },
        list_id: targetListId,
        status: statusPayload,
      };

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

      const cacheAfterProgress = this._context && this._context.cache;
      if (cacheAfterProgress && typeof cacheAfterProgress.deleteValue === 'function') {
        await cacheAfterProgress.deleteValue(`getSeriesListStatus%%${numericSeriesId}`);
      }
    }

    if (typeof progress.rating === 'number' && progress.rating >= 0) {
      // mangalist's own Bookmark rating scale treats 0 as "cleared"
      // (mangalist.cjs's reset-rating flow writes user_rating: 0) — route
      // to delete rather than writing a literal 0 rating (owner correction
      // 2026-07-23, same fix applied to the MangaDex wrapper for symmetry).
      const ratingResult = progress.rating === 0
        ? await this.deleteSerieRating(String(numericSeriesId))
        : await this.updateSerieRating(String(numericSeriesId), {
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
   * @param {Record<string, unknown> | string} searchable
   * @param {{ useCache?: boolean, searchTitles?: string[] }} [options]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async searchTrackers(searchable, options = {}) {
    const useCache = !(options && typeof options === 'object' && options.useCache === false);
    const titles = this._buildTitleList(searchable, options);
    if (titles.length === 0) {
      return [];
    }

    const matchResult = await this._findExactMatch(titles, useCache);
    if (matchResult.match) {
      const resolvedMatchType = matchResult.matchType === 'fuzzy' ? 'fuzzy' : 'exact';
      const record = matchResult.match && typeof matchResult.match === 'object' && matchResult.match.record
        && typeof matchResult.match.record === 'object'
        ? matchResult.match.record
        : null;
      const seriesId = record && (typeof record.series_id === 'number' || typeof record.series_id === 'string')
        ? Number(record.series_id)
        : NaN;

      if (Number.isFinite(seriesId) && seriesId > 0) {
        const detail = await this.getSerieDetail(seriesId, { useCache });
        if (detail && typeof detail === 'object') {
          const normalized = this._normalizeSeriesData(detail);
          return [{
            ...normalized,
            matchType: resolvedMatchType,
            confidence: resolvedMatchType === 'exact' ? 100 : 80,
          }];
        }
      }

      return [this._mapSearchResult(matchResult.match, resolvedMatchType)];
    }

    const bestSnapshot = await this._selectBestSearchSnapshot(titles, {
      useCache,
      perpage: 5,
      limit: 5,
      stopOnExact: true,
    });

    if (bestSnapshot && Array.isArray(bestSnapshot.rows) && bestSnapshot.rows.length > 0) {
      return bestSnapshot.rows.map((entry) => this._mapSearchResult(entry.result, 'manual'));
    }

    return [];
  }

  /**
   * @param {Record<string, unknown> | string} searchable
   * @param {{ useCache?: boolean, searchTitles?: string[] }} [options]
   * @returns {Promise<MangaUpdatesRawSearchResponse>}
   */
  async searchTrackersRaw(searchable, options = {}) {
    const useCache = !(options && typeof options === 'object' && options.useCache === false);
    const titles = this._buildTitleList(searchable, options);
    const normalizedQuery = titles.length > 0 ? titles[0] : '';

    try {
      const bestSnapshot = await this._selectBestSearchSnapshot(titles, {
        useCache,
        perpage: 25,
        limit: 5,
        stopOnExact: true,
      });

      if (bestSnapshot && Array.isArray(bestSnapshot.rows) && bestSnapshot.rows.length > 0) {
        const hydratedRows = await Promise.all(bestSnapshot.rows.map(async (entry) => {
          const result = entry && typeof entry === 'object' ? entry.result : null;
          if (!result || typeof result !== 'object') {
            return result;
          }

          const row = result.record && typeof result.record === 'object'
            ? result.record
            : null;
          const seriesId = row && (typeof row.series_id === 'number' || typeof row.series_id === 'string')
            ? Number(row.series_id)
            : NaN;

          if (!Number.isFinite(seriesId) || seriesId <= 0) {
            return result;
          }

          try {
            const detail = await this.getSerieDetail(seriesId, { useCache });
            if (!detail || typeof detail !== 'object') {
              return result;
            }

            return {
              ...result,
              record: detail,
            };
          } catch {
            // Preserve ranked search result when detail hydration fails.
            return result;
          }
        }));

        const items = hydratedRows.map((result) => {
          const row = result && typeof result === 'object' && result.record && typeof result.record === 'object'
            ? result.record
            : null;
          const itemId = row && (typeof row.series_id === 'number' || typeof row.series_id === 'string')
            ? String(row.series_id)
            : `mu-${toSlug(typeof normalizedQuery === 'string' ? normalizedQuery : '')}`;
          const itemTitle = row && typeof row.title === 'string' && row.title.trim()
            ? row.title.trim()
            : result && typeof result === 'object' && typeof result.hit_title === 'string' && result.hit_title.trim()
              ? result.hit_title.trim()
              : normalizedQuery;

          if (result && typeof result === 'object') {
            return {
              ...result,
              id: itemId,
              title: itemTitle,
            };
          }

          return {
            id: itemId,
            title: itemTitle,
          };
        });

        return {
          trackerId: 'mangaupdates',
          operation: 'searchTrackersRaw',
          payload: { data: items },
        };
      }
    } catch (error) {
      // Fall through to legacy placeholder to preserve baseline contract behavior.
    }

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
   * @param {Record<string, unknown>} mangaCoreEntry
   * @param {{ useCache?: boolean, trackerId?: string|number, onProgress?: Function }} [options]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async searchCovers(mangaCoreEntry, options = {}) {
    const useCache = !(options && typeof options === 'object' && options.useCache === false);
    const trackerIdFromOptions = options && typeof options === 'object' ? options.trackerId : null;
    const onProgress = options && typeof options === 'object' && typeof options.onProgress === 'function'
      ? options.onProgress
      : null;
    const startedAt = Date.now();

    const emit = (status, detail, extra = {}) => {
      if (!onProgress) {
        return;
      }

      onProgress({
        source: SERVICE_NAME,
        status,
        detail,
        timestamp: new Date().toISOString(),
        ...extra,
      });
    };

    const trackerId = trackerIdFromOptions || this._getTrackerId(mangaCoreEntry);
    if (trackerId) {
      emit('running', `Fetching cover by tracker id ${trackerId}`);
      const detail = await this.getSerieDetail(Number(trackerId), { useCache });
      const coverUrl = this._extractCoverUrl(detail);
      if (detail && coverUrl) {
        const normalized = [this._normalizeCoverSearchResult(detail, mangaCoreEntry, {
          matchType: 'exact',
          similarity: 1,
          attempts: 1,
          cacheHit: useCache,
          startedAt,
        })];
        emit('complete', 'Cover lookup completed from tracker id', { results: normalized });
        return normalized;
      }
    }

    const titles = this._buildTitleList(mangaCoreEntry, options);
    if (titles.length === 0) {
      emit('error', 'No searchable titles available for cover lookup');
      return [];
    }

    emit('running', 'Searching tracker for cover candidates');
    const matchResult = await this._findExactMatch(titles, useCache);
    if (!matchResult.match) {
      emit('error', 'No cover candidate found');
      return [];
    }

    const resolvedMatchType = matchResult.matchType === 'fuzzy' ? 'fuzzy' : 'exact';

    const row = matchResult.match && typeof matchResult.match === 'object' && matchResult.match.record
      && typeof matchResult.match.record === 'object'
      ? matchResult.match.record
      : null;
    const seriesId = row && (typeof row.series_id === 'number' || typeof row.series_id === 'string')
      ? Number(row.series_id)
      : NaN;

    if (Number.isFinite(seriesId) && seriesId > 0) {
      const detail = await this.getSerieDetail(seriesId, { useCache });
      if (detail && this._extractCoverUrl(detail)) {
        const normalized = [this._normalizeCoverSearchResult(detail, mangaCoreEntry, {
          matchType: resolvedMatchType,
          similarity: matchResult.similarity,
          attempts: matchResult.attempts,
          cacheHit: matchResult.cacheHit,
          startedAt,
        })];
        emit('complete', 'Cover lookup completed from exact match', { results: normalized });
        return normalized;
      }
    }

    const coverUrl = this._extractCoverUrl(row);
    if (!coverUrl) {
      emit('error', 'Exact match found but no cover url available');
      return [];
    }

    const normalized = [this._normalizeCoverSearchResult(row, mangaCoreEntry, {
      matchType: resolvedMatchType,
      similarity: matchResult.similarity,
      attempts: matchResult.attempts,
      cacheHit: matchResult.cacheHit,
      startedAt,
    })];
    emit('complete', 'Cover lookup completed from search fallback', { results: normalized });
    return normalized;
  }

  /**
   * @param {Record<string, unknown>} metadata
   * @param {string} savePath
   * @returns {Promise<boolean>}
   */
  /**
   * host-capability-contract.md §2's enrich.cover mapping. Unlike MangaDex's equivalent, MangaUpdates'
   * cover URL is CDN-assigned and not deterministically derivable from the series id + filename
   * alone (confirmed via _extractCoverUrl()'s own candidate list — no fixed URL pattern like
   * MangaDex's `/covers/{mangaId}/{fileName}`), so this method re-resolves the series detail
   * (typically a cache hit, since a download normally follows shortly after the searchCovers() call
   * that surfaced this coverId) and re-extracts the URL the same way searchCovers()'s own id-mode
   * path already does. This means, unlike MangaDex's downloadCover, this method now requires a
   * credential (getSerieDetail() calls getToken()) — a real, necessary behavioral difference from
   * the pre-migration unauthenticated shape, not an oversight.
   * @param {string} coverId - "${seriesId}/${fileName}", host-constructed per ImageService's own
   *   bridging convention (not required to be plugin-parseable in general — only the seriesId half
   *   is actually used to resolve the URL; fileName is reused only for the image-byte cache key,
   *   matching the pre-migration cache-key scheme).
   * @returns {Promise<Buffer>}
   */
  async downloadCover(coverId) {
    const parts = typeof coverId === 'string' ? coverId.split('/') : [];
    const seriesId = parts[0] ? Number(parts[0]) : NaN;
    if (!Number.isFinite(seriesId) || seriesId <= 0) {
      throw new Error('(downloadCover) Invalid coverId');
    }
    const fileName = parts[1] || 'cover.jpg';

    const cacheKey = `mangaupdates_downloadCover_${seriesId}_${fileName}`;
    const cacheForCover = this._context && this._context.cache;
    if (cacheForCover && typeof cacheForCover.getValue === 'function') {
      const cached = await cacheForCover.getValue(cacheKey);
      if (typeof cached === 'string' && cached.length > 0) {
        return Buffer.from(cached, 'base64');
      }
    }

    const detail = await this.getSerieDetail(seriesId, { useCache: true });
    const url = this._extractCoverUrl(detail);
    if (!url) {
      throw new Error('(downloadCover) No cover URL available for this series');
    }

    if (!this.httpClient || typeof this.httpClient.get !== 'function') {
      throw new Error('(downloadCover) HTTP client get method is not configured');
    }

    const response = await this.httpClient.get(url, { responseType: 'arraybuffer' });
    const responseData = response && typeof response === 'object' ? response.data : null;
    /** @type {Buffer | null} */
    let imageBuffer = null;
    if (Buffer.isBuffer(responseData)) {
      imageBuffer = responseData;
    } else if (responseData instanceof ArrayBuffer) {
      imageBuffer = Buffer.from(responseData);
    } else if (ArrayBuffer.isView(responseData)) {
      imageBuffer = Buffer.from(responseData.buffer);
    } else if (typeof responseData === 'string') {
      imageBuffer = Buffer.from(responseData, 'binary');
    }

    if (!imageBuffer) {
      throw new Error('(downloadCover) Failed to fetch cover image bytes');
    }

    if (cacheForCover && typeof cacheForCover.setValue === 'function') {
      await cacheForCover.setValue(cacheKey, imageBuffer.toString('base64'), 24 * 60 * 60);
    }

    return imageBuffer;
  }

  /**
   * @param {string[]} titles
   * @param {boolean} [useCache]
   * @returns {Promise<{
   *  match: Record<string, unknown> | null,
   *  attempts: number,
   *  cacheHit: boolean,
   *  matchType: 'exact' | 'fuzzy' | null,
   *  similarity: number,
   * }>}
   */
  async _findExactMatch(titles, useCache = true) {
    if (!Array.isArray(titles) || titles.length === 0) {
      return {
        match: null,
        attempts: 0,
        cacheHit: false,
        matchType: null,
        similarity: 0,
      };
    }

    if (!useCache) {
      await this.refresh(true);
    }

    const bestSnapshot = await this._selectBestSearchSnapshot(titles, {
      useCache,
      perpage: 25,
      limit: 25,
      stopOnExact: true,
    });

    if (!useCache) {
      await this.refresh(false);
    }

    if (bestSnapshot && bestSnapshot.bestRow && bestSnapshot.bestRow.matchType === 'exact') {
      return {
        match: bestSnapshot.bestRow.result,
        attempts: bestSnapshot.attempts,
        cacheHit: false,
        matchType: 'exact',
        similarity: 1,
      };
    }

    if (bestSnapshot && bestSnapshot.bestRow && bestSnapshot.bestRow.matchType === 'fuzzy') {
      return {
        match: bestSnapshot.bestRow.result,
        attempts: bestSnapshot.attempts,
        cacheHit: false,
        matchType: 'fuzzy',
        similarity: bestSnapshot.bestRow.similarity,
      };
    }

    return {
      match: null,
      attempts: bestSnapshot ? bestSnapshot.attempts : 0,
      cacheHit: false,
      matchType: null,
      similarity: 0,
    };
  }

  /**
   * Evaluate all candidate query titles and retain the best-ranked snapshot.
   * Stops early only when an exact (100%) match appears.
   * @param {string[]} titles
   * @param {{ useCache: boolean, perpage: number, limit: number, stopOnExact?: boolean }} options
   * @returns {Promise<{
   *  title: string,
   *  rows: Array<{ result: Record<string, unknown>, matchType: 'exact'|'fuzzy'|'search', similarity: number, index: number }>,
   *  bestRow: { result: Record<string, unknown>, matchType: 'exact'|'fuzzy'|'search', similarity: number, index: number } | null,
   *  attempts: number,
   * } | null>}
   */
  async _selectBestSearchSnapshot(titles, options) {
    const normalizedTitles = Array.isArray(titles)
      ? titles.filter((title) => typeof title === 'string' && title.trim().length > 0)
      : [];
    if (normalizedTitles.length === 0) {
      return null;
    }

    const exactMatchPolicyRaw = this._resolveSettingValue('search.exactMatchPolicy');
    const stopOnExact = exactMatchPolicyRaw === 'highestScore' ? false : !!(options && options.stopOnExact);
    const perpage = Number.isFinite(options?.perpage) && options.perpage > 0
      ? Math.trunc(options.perpage)
      : 25;
    const candidateLimitRaw = this._resolveSettingValue('search.candidateLimit');
    const candidateLimit = typeof candidateLimitRaw === 'number' && Number.isFinite(candidateLimitRaw) && candidateLimitRaw > 0
      ? Math.trunc(candidateLimitRaw)
      : 5;
    const limit = Number.isFinite(options?.limit) && options.limit > 0
      ? Math.trunc(options.limit)
      : candidateLimit;

    /** @type {{
     *  title: string,
     *  rows: Array<{ result: Record<string, unknown>, matchType: 'exact'|'fuzzy'|'search', similarity: number, index: number }>,
     *  bestRow: { result: Record<string, unknown>, matchType: 'exact'|'fuzzy'|'search', similarity: number, index: number } | null,
     *  attempts: number,
     * } | null} */
    let bestSnapshot = null;

    let attempts = 0;

    for (const title of normalizedTitles) {
      attempts += 1;

      const searchResults = await this.serieSearch(
        {
          search: title,
          stype: 'title',
          type: ['manga', 'manhua', 'manhwa'],
          perpage,
        },
        { useCache: options?.useCache !== false },
      );

      if (!Array.isArray(searchResults) || searchResults.length === 0) {
        continue;
      }

      const ranked = this._rankSearchCandidates(normalizedTitles, searchResults, Math.max(limit, searchResults.length));
      const topRows = ranked.slice(0, limit);
      const bestRow = topRows.length > 0 ? topRows[0] : null;

      if (!bestRow) {
        continue;
      }

      const snapshot = {
        title,
        rows: topRows,
        bestRow,
        attempts,
      };

      if (!bestSnapshot) {
        bestSnapshot = snapshot;
      } else {
        const currentRank = this._resolveMatchTypeRank(bestSnapshot.bestRow ? bestSnapshot.bestRow.matchType : 'search');
        const nextRank = this._resolveMatchTypeRank(bestRow.matchType);

        if (nextRank < currentRank) {
          bestSnapshot = snapshot;
        } else if (nextRank === currentRank) {
          const currentSimilarity = bestSnapshot.bestRow ? bestSnapshot.bestRow.similarity : 0;
          if (bestRow.similarity > currentSimilarity) {
            bestSnapshot = snapshot;
          }
        }
      }

      if (stopOnExact && bestRow.matchType === 'exact') {
        return {
          ...snapshot,
          attempts,
        };
      }
    }

    if (!bestSnapshot) {
      return null;
    }

    return {
      ...bestSnapshot,
      attempts,
    };
  }

  /**
   * @param {'exact'|'fuzzy'|'search'} matchType
   * @returns {number}
   */
  _resolveMatchTypeRank(matchType) {
    if (matchType === 'exact') {
      return 0;
    }
    if (matchType === 'fuzzy') {
      return 1;
    }
    return 2;
  }

  /**
   * @param {string[]} targetTitles
   * @param {Array<Record<string, unknown>>} searchResults
   * @param {number} [limit]
   * @returns {Array<{ result: Record<string, unknown>, matchType: 'exact'|'fuzzy'|'search', similarity: number, index: number }>}
   */
  _rankSearchCandidates(targetTitles, searchResults, limit = 5) {
    const fuzzyThresholdRaw = this._resolveSettingValue('search.fuzzyThreshold');
    const fuzzyThreshold = typeof fuzzyThresholdRaw === 'number' && Number.isFinite(fuzzyThresholdRaw) && fuzzyThresholdRaw > 0
      ? fuzzyThresholdRaw
      : 0.60;
    const containmentScoreRaw = this._resolveSettingValue('search.containmentScore');
    const containmentScore = typeof containmentScoreRaw === 'number' && Number.isFinite(containmentScoreRaw)
      ? containmentScoreRaw
      : 0.85;
    /** @type {Array<{ result: Record<string, unknown>, matchType: 'exact'|'fuzzy'|'search', similarity: number, index: number }>}
     */
    const ranked = [];

    for (let index = 0; index < searchResults.length; index += 1) {
      const result = searchResults[index];
      const candidateTitles = this._collectCandidateTitles(result);
      const similarityData = calculateTitleSimilarity(targetTitles, candidateTitles, containmentScore);

      if (similarityData.hasExactMatch) {
        ranked.push({
          result,
          matchType: 'exact',
          similarity: 1,
          index,
        });
        continue;
      }

      if (similarityData.bestSimilarity >= fuzzyThreshold) {
        ranked.push({
          result,
          matchType: 'fuzzy',
          similarity: similarityData.bestSimilarity,
          index,
        });
        continue;
      }

      ranked.push({
        result,
        matchType: 'search',
        similarity: similarityData.bestSimilarity,
        index,
      });
    }

    ranked.sort((a, b) => {
      const aRank = a.matchType === 'exact' ? 0 : a.matchType === 'fuzzy' ? 1 : 2;
      const bRank = b.matchType === 'exact' ? 0 : b.matchType === 'fuzzy' ? 1 : 2;
      if (aRank !== bRank) {
        return aRank - bRank;
      }

      if (b.similarity !== a.similarity) {
        return b.similarity - a.similarity;
      }

      return a.index - b.index;
    });

    return ranked.slice(0, limit);
  }

  /**
   * @param {Record<string, unknown>} result
   * @returns {string[]}
   */
  _collectCandidateTitles(result) {
    /** @type {string[]} */
    const titles = [];
    if (result && typeof result === 'object' && typeof result.hit_title === 'string' && result.hit_title.trim()) {
      titles.push(result.hit_title);
    }

    const row = result && typeof result === 'object' && result.record && typeof result.record === 'object'
      ? result.record
      : null;
    if (row && typeof row.title === 'string' && row.title.trim()) {
      titles.push(row.title);
    }

    const associated = row && Array.isArray(row.associated) ? row.associated : [];
    for (const entry of associated) {
      if (entry && typeof entry === 'object' && typeof entry.title === 'string' && entry.title.trim()) {
        titles.push(entry.title);
      }
    }

    const deduped = [];
    const seen = new Set();
    for (const title of titles) {
      const normalized = title.trim();
      const key = normalized.toLowerCase();
      if (!normalized || seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push(normalized);
    }

    return deduped;
  }

  /**
   * @param {Record<string, unknown> | string | null | undefined} searchable
   * @param {{ searchTitles?: string[] }} [options]
   * @returns {string[]}
   */
  _buildTitleList(searchable, options = {}) {
    /** @type {string[]} */
    const titles = [];
    const searchTitles = options && typeof options === 'object' && Array.isArray(options.searchTitles)
      ? options.searchTitles
      : [];
    titles.push(...searchTitles);

    if (typeof searchable === 'string') {
      titles.push(searchable);
    } else if (searchable && typeof searchable === 'object') {
      if (typeof searchable.title === 'string') {
        titles.push(searchable.title);
      }
      if (typeof searchable.name === 'string') {
        titles.push(searchable.name);
      }
      if (typeof searchable.alias === 'string') {
        titles.push(searchable.alias);
      }

      const aliases = Array.isArray(searchable.aliases) ? searchable.aliases : [];
      for (const alias of aliases) {
        if (typeof alias === 'string') {
          titles.push(alias);
        }
      }

      const alternatives = Array.isArray(searchable.alternativeTitles) ? searchable.alternativeTitles : [];
      for (const alternative of alternatives) {
        if (typeof alternative === 'string') {
          titles.push(alternative);
        }
      }
    }

    /** @type {string[]} */
    const deduped = [];
    const seen = new Set();
    for (const title of titles) {
      if (typeof title !== 'string') {
        continue;
      }

      const normalized = title.trim();
      if (!normalized) {
        continue;
      }

      const dedupeKey = normalized.toLowerCase();
      if (seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      deduped.push(normalized);
    }

    return deduped;
  }

  /**
   * @param {string[]} expectedTitles
   * @param {string[]} candidateTitles
   * @returns {boolean}
   */
  _hasExactTitleMatch(expectedTitles, candidateTitles) {
    const expected = new Set(
      expectedTitles
        .filter((title) => typeof title === 'string')
        .map((title) => toSlug(title))
        .filter(Boolean),
    );

    for (const candidateTitle of candidateTitles) {
      if (typeof candidateTitle !== 'string') {
        continue;
      }

      const candidateSlug = toSlug(candidateTitle);
      if (candidateSlug && expected.has(candidateSlug)) {
        return true;
      }
    }

    return false;
  }

  /**
   * @param {Record<string, unknown>} searchResult
  * @param {'exact' | 'fuzzy' | 'manual'} matchType
   * @returns {Record<string, unknown>}
   */
  _mapSearchResult(searchResult, matchType) {
    const row = searchResult && typeof searchResult === 'object' && searchResult.record && typeof searchResult.record === 'object'
      ? searchResult.record
      : {};
    const associated = Array.isArray(row.associated) ? row.associated : [];

    return {
      source: SERVICE_NAME,
      trackerId: row && (typeof row.series_id === 'number' || typeof row.series_id === 'string')
        ? row.series_id
        : null,
      title: typeof row.title === 'string' && row.title.trim()
        ? row.title
        : searchResult && typeof searchResult === 'object' && typeof searchResult.hit_title === 'string'
          ? searchResult.hit_title
          : '',
      alternativeTitles: associated
        .map((entry) => (entry && typeof entry === 'object' && typeof entry.title === 'string' ? entry.title : null))
        .filter((entry) => entry !== null),
      coverUrl: this._extractCoverUrl(row),
      metadata: {
        url: typeof row.url === 'string' ? row.url : null,
        matchedTitle: searchResult && typeof searchResult === 'object' && typeof searchResult.hit_title === 'string'
          ? searchResult.hit_title
          : null,
      },
      confidence: matchType === 'exact' ? 100 : matchType === 'fuzzy' ? 80 : 0,
      matchType,
    };
  }

  /**
   * @param {Record<string, unknown> | null | undefined} payload
   * @returns {string | null}
   */
  _extractCoverUrl(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const image = payload.image && typeof payload.image === 'object' ? payload.image : null;
    const imageAsString = typeof payload.image === 'string' ? payload.image : null;
    const url = image && image.url && typeof image.url === 'object' ? image.url : null;
    const urlAsString = image && typeof image.url === 'string' ? image.url : null;

    const normalizeCoverUrl = (candidate) => {
      if (typeof candidate !== 'string') {
        return null;
      }

      const trimmed = candidate.trim();
      if (!trimmed) {
        return null;
      }

      if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
      }

      if (trimmed.startsWith('/image/')) {
        return `https://cdn.mangaupdates.com${trimmed}`;
      }

      if (trimmed.startsWith('image/')) {
        return `https://cdn.mangaupdates.com/${trimmed}`;
      }

      if (/^i\d+\.(jpg|jpeg|png|webp)$/i.test(trimmed)) {
        return `https://cdn.mangaupdates.com/image/${trimmed}`;
      }

      return null;
    };

    const candidates = [
      url ? url.original : null,
      url ? url.thumb : null,
      url ? url.small : null,
      url ? url.medium : null,
      url ? url.large : null,
      urlAsString,
      image && typeof image.original === 'string' ? image.original : null,
      image && typeof image.thumb === 'string' ? image.thumb : null,
      image && typeof image.small === 'string' ? image.small : null,
      image && typeof image.medium === 'string' ? image.medium : null,
      image && typeof image.large === 'string' ? image.large : null,
      imageAsString,
      typeof payload.coverUrl === 'string' ? payload.coverUrl : null,
    ];

    for (const candidate of candidates) {
      const normalized = normalizeCoverUrl(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  /**
   * @param {Record<string, unknown>} detail
   * @param {Record<string, unknown>} mangaCoreEntry
   * @param {{
   *  matchType: 'exact' | 'fuzzy' | 'manual',
   *  similarity?: number,
   *  attempts?: number,
   *  cacheHit?: boolean,
   *  startedAt?: number,
   * }} context
   * @returns {Record<string, unknown>}
   */
  _normalizeCoverSearchResult(detail, mangaCoreEntry, context) {
    const matchType = context && typeof context === 'object' && typeof context.matchType === 'string'
      ? context.matchType
      : 'manual';
    const coverUrl = this._extractCoverUrl(detail);
    const seriesId = detail && (typeof detail.series_id === 'number' || typeof detail.series_id === 'string')
      ? String(detail.series_id)
      : detail && (typeof detail.id === 'number' || typeof detail.id === 'string')
        ? String(detail.id)
        : 'unknown';
    const title = detail && typeof detail.title === 'string' && detail.title.trim()
      ? detail.title.trim()
      : mangaCoreEntry && typeof mangaCoreEntry.title === 'string' && mangaCoreEntry.title.trim()
        ? mangaCoreEntry.title.trim()
        : `series-${seriesId}`;
    const similarity = context && typeof context.similarity === 'number' && Number.isFinite(context.similarity)
      ? context.similarity
      : null;
    const score = this._resolveCoverMatchScore(matchType, similarity);
    const canonicalUrl = detail && typeof detail.url === 'string' && detail.url.trim()
      ? detail.url.trim()
      : `https://www.mangaupdates.com/series/${seriesId}`;
    const fetchedAt = new Date().toISOString();
    const startedAt = context && typeof context.startedAt === 'number' ? context.startedAt : Date.now();
    const attempts = context && typeof context.attempts === 'number' && Number.isFinite(context.attempts)
      ? Math.max(1, Math.round(context.attempts))
      : 1;

    const fileName = `${toSlug(title) || `series-${seriesId}`}.jpg`;

    return {
      source: SERVICE_NAME,
      title,
      thumbnailUrl: coverUrl || '',
      canonicalUrl,
      // ImageService's own bridging convention (coverId = `${sourceId}/${fileName}`) — matches
      // MangaDex's own precedent; not yet read by any host call site, added for consistency and the
      // eventual PluginCoverResult.coverId consumer.
      coverId: `${seriesId}/${fileName}`,
      tracker: {
        id: seriesId,
        url: coverUrl || '',
        fileName,
        description: title,
        score,
        extras: {
          matchType,
          similarity,
          seriesId,
          mangaCoreKey: mangaCoreEntry && typeof mangaCoreEntry === 'object' && typeof mangaCoreEntry.key === 'string'
            ? mangaCoreEntry.key
            : null,
        },
      },
      fetchedAt,
      telemetry: {
        durationMs: Math.max(0, Date.now() - startedAt),
        cacheHit: context && context.cacheHit === true,
        attempts,
      },
    };
  }

  /**
   * @param {'exact' | 'fuzzy' | 'manual'} matchType
   * @param {number | null} similarity
   * @returns {number}
   */
  _resolveCoverMatchScore(matchType, similarity) {
    if (matchType === 'exact') {
      return 100;
    }

    if (matchType === 'fuzzy') {
      if (typeof similarity === 'number' && Number.isFinite(similarity)) {
        const boundedSimilarity = Math.max(0, Math.min(1, similarity));
        return Math.max(60, Math.min(95, Math.round(boundedSimilarity * 100)));
      }
      return 80;
    }

    return 50;
  }

  /**
   * @param {Record<string, unknown> | null | undefined} mangaCoreEntry
   * @returns {number | null}
   */
  _getTrackerId(mangaCoreEntry) {
    if (!mangaCoreEntry || typeof mangaCoreEntry !== 'object') {
      return null;
    }

    const trackerMappings = mangaCoreEntry.trackerMappings && typeof mangaCoreEntry.trackerMappings === 'object'
      ? mangaCoreEntry.trackerMappings
      : null;
    const mapping = trackerMappings && trackerMappings.mangaupdates && typeof trackerMappings.mangaupdates === 'object'
      ? trackerMappings.mangaupdates
      : null;

    const candidate = mapping && (mapping.id !== undefined ? mapping.id : mapping.trackerId);
    const numeric = Number(candidate);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
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
      console.error(`[mangaupdates] getSeriesByIdRaw(${trackerId}) failed:`, error instanceof Error ? error.message : error);
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
