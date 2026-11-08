'use strict';

/**
 * L4 — MangaUpdates' client: REACH and EXCHANGE (Plan-2026Q4-tracker-plugin-standardization §1.2).
 *
 * Talks to api.mangaupdates.com and returns its own shapes. Endpoints are the settings' templates; every request
 * goes through `view.http`, bound per call by the SDK to the call's credential, identity, scope and signal. One
 * source call per contract method, named after it (the template's convention): the SDK binds
 * `mapping.<method>(await client.<method>(...))`.
 *
 * Source facts this file relies on (MangaUpdates API v1, https://api.mangaupdates.com/openapi.yaml, and the 3.x
 * wrapper's live checks of 2026-07-23 and 2026-11-07):
 *  - authentication is a session: `PUT /account/login` with `{ username, password }` answers
 *    `{ context: { session_token } }`; the token is sent as `Authorization: Bearer`. It lives 12 hours; a 401 on
 *    an authenticated request means it died early: the SDK logs in again once and replays once.
 *  - every user has typed lists (`GET /lists`: `{ list_id, title, type, custom }`, `type` one of read, wish,
 *    complete, unfinished, hold) and may make custom ones, which carry one of those types too. `list_id` is per
 *    account; the status token this plugin speaks is the list's `type` (Decision 2), the id travels as `listId`.
 *  - a list's series are read with `POST /lists/{list_id}/search` `{ page, perpage }`, paged.
 *  - one series' membership: `GET /lists/series/{series_id}` (404 when on no list); add `POST /lists/series`,
 *    move or update `POST /lists/series/update`, remove `POST /lists/series/delete` with an array of series ids
 *    (live-confirmed 2026-11-07: the site works out the list; the old `DELETE /lists/{list}/series/{series}` answered
 *    405). A write the site refuses answers 200 with `{ status: 'exception', reason }`, in any case.
 *  - the reading-list chapter is an integer (openapi `ListsSeriesModelV1Status.chapter`, and 0 fractional
 *    chapters in a 1,972-entry account, 2026-07-23). The user's rating is `GET|PUT|DELETE /series/{id}/rating`
 *    (`{ rating }`, 404 when unrated, verified live 2026-07-23); the list read carries it as `metadata.user_rating`.
 *  - a cover URL is CDN-assigned (`image.url.original`), never derivable from the id.
 *  - the edge can answer an HTML page (Cloudflare) where JSON belongs.
 */

const { PluginError, isPluginError } = require('@manga-list/plugin-sdk');

/** A session token is retired this long before its lifetime ends, so no request leaves with one about to die. */
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

/** The list types MangaUpdates gives every list (openapi `ListsModelV1.type`). */
const LIST_TYPES = Object.freeze(['read', 'wish', 'complete', 'unfinished', 'hold']);

/** A page cap for one list's paged read: far beyond any real list, so a source that never ends cannot loop us. */
const MAX_LIST_PAGES = 1000;

/**
 * @param {Record<string, unknown>} settings
 * @param {string} name - the endpoint's settings name (api.endpoints.<name>.template)
 * @param {Record<string, string | number>} [params]
 */
function endpoint(settings, name, params = {}) {
    const template = settings[`api.endpoints.${name}.template`];
    if (typeof template !== 'string' || !template) {
        throw new PluginError('source_error', `MangaUpdates: no endpoint template for '${name}' in the settings`);
    }
    /** @type {Record<string, string>} */
    const values = { baseUrl: String(settings['api.baseUrl'] || '') };
    for (const [key, value] of Object.entries(params)) values[key] = encodeURIComponent(String(value));
    let url = template;
    for (const [key, value] of Object.entries(values)) url = url.split(`\${${key}}`).join(value);
    return url;
}

/**
 * The session login. The credential is `{ username, password }` (the manifest's credentialOptions.fields).
 */
const auth = {
    /**
     * @param {{ username?: string, password?: string } | null} credential
     * @param {{ http: import('@manga-list/plugin-sdk').CallHttp, settings: Record<string, unknown> }} ctx
     */
    async exchange(credential, { http, settings }) {
        const username = credential && typeof credential.username === 'string' ? credential.username.trim() : '';
        const password = credential && typeof credential.password === 'string' ? credential.password : '';
        if (!username || !password) {
            throw new PluginError('credential_rejected', 'no MangaUpdates username and password were presented');
        }
        const response = await http.request({
            method: 'put',
            url: endpoint(settings, 'login'),
            data: { username, password },
            headers: { 'Content-Type': 'application/json' },
            endpoint: 'login',
        });
        const body = response && response.data && typeof response.data === 'object' ? response.data : {};
        const token = body.context && typeof body.context.session_token === 'string' && body.context.session_token
            ? body.context.session_token
            : (typeof body.session_token === 'string' ? body.session_token : '');
        if (!token) {
            const reason = typeof body.reason === 'string' && body.reason ? `: ${body.reason}` : '';
            throw new PluginError('credential_rejected', `MangaUpdates gave no session for this credential${reason}`);
        }
        const lifetimeS = Number(settings['cache.ttl.sessionToken']) || 12 * 60 * 60;
        return { tokens: { session: { value: token, expiresAt: Date.now() + lifetimeS * 1000 - TOKEN_EXPIRY_SKEW_MS } } };
    },
    /**
     * @param {Record<string, { value: string }>} tokens
     * @param {Record<string, any>} config
     */
    apply(tokens, config) {
        return { ...config, headers: { ...(config.headers || {}), Authorization: `Bearer ${tokens.session.value}` } };
    },
};

/**
 * @param {string} html
 * @returns {string}
 */
function htmlErrorMessage(html) {
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (title && title[1] && title[1].trim()) return title[1].trim();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 180) : 'an HTML error page';
}

/**
 * MangaUpdates' edge can answer with an HTML page (a Cloudflare challenge or a backend error) where JSON belongs:
 * a typed error, never a parse of HTML. An empty body is no page: the site answers a series on none of the account's
 * lists with a 404, `text/html` and nothing in it (live 2026-11-08), which is the status's own answer (`not_found`).
 * @param {any} response
 */
function htmlNormalizer(response) {
    const headers = response && response.headers ? response.headers : {};
    const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'] : '';
    const data = response ? response.data : null;
    const isHtml = contentType.includes('text/html') || (typeof data === 'string' && /^\s*<(?:!doctype|html)/i.test(data));
    const isEmpty = data === null || data === undefined || (typeof data === 'string' && !data.trim());
    if (isHtml && !isEmpty && !(data instanceof Uint8Array)) {
        throw new PluginError('offline', `MangaUpdates backend infrastructure error: ${htmlErrorMessage(typeof data === 'string' ? data : '')}`, { status: response.status });
    }
}

/**
 * A write the site refused answers 200 with `{ status: 'exception', reason }` — in any case (live 2026-11-07).
 * @param {any} response
 * @param {string} what
 */
function assertAccepted(response, what) {
    const body = response && response.data && typeof response.data === 'object' ? response.data : null;
    if (body && String(body.status || '').toLowerCase() === 'exception') {
        const reason = typeof body.reason === 'string' && body.reason ? body.reason : 'no reason given';
        throw new PluginError('source_error', `MangaUpdates refused ${what}: ${reason}`);
    }
}

/** @param {unknown} error */
const isNotFound = (error) => isPluginError(error) && error.code === 'not_found';

/** @param {unknown} data */
function toBuffer(data) {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (typeof data === 'string') return Buffer.from(data, 'binary');
    throw new PluginError('source_error', 'MangaUpdates answered no image bytes');
}

/**
 * The cover URL a series (or a search row's record) carries: CDN-assigned, so it is read, never built.
 * @param {any} payload
 * @returns {string | null}
 */
function coverUrlOf(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const image = payload.image && typeof payload.image === 'object' ? payload.image : null;
    const url = image && image.url && typeof image.url === 'object' ? image.url : null;
    /** @param {unknown} candidate */
    const normalize = (candidate) => {
        if (typeof candidate !== 'string') return null;
        const trimmed = candidate.trim();
        if (!trimmed) return null;
        if (/^https?:\/\//i.test(trimmed)) return trimmed;
        if (trimmed.startsWith('/image/')) return `https://cdn.mangaupdates.com${trimmed}`;
        if (trimmed.startsWith('image/')) return `https://cdn.mangaupdates.com/${trimmed}`;
        if (/^i\d+\.(jpg|jpeg|png|webp)$/i.test(trimmed)) return `https://cdn.mangaupdates.com/image/${trimmed}`;
        return null;
    };
    const candidates = [
        url && url.original, url && url.thumb, url && url.small, url && url.medium, url && url.large,
        image && typeof image.url === 'string' ? image.url : null,
        image && image.original, image && image.thumb, image && image.small, image && image.medium, image && image.large,
        typeof payload.image === 'string' ? payload.image : null,
        payload.coverUrl,
    ];
    for (const candidate of candidates) {
        const out = normalize(candidate);
        if (out) return out;
    }
    return null;
}

/** @param {string} value */
function toSlug(value) {
    return typeof value === 'string'
        ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
        : '';
}

/**
 * Every title a search row carries: the hit, the record's title and its associated names, deduplicated.
 * @param {any} row
 * @returns {string[]}
 */
function rowTitles(row) {
    /** @type {string[]} */
    const titles = [];
    if (row && typeof row.hit_title === 'string') titles.push(row.hit_title);
    const record = row && row.record && typeof row.record === 'object' ? row.record : null;
    if (record && typeof record.title === 'string') titles.push(record.title);
    for (const entry of record && Array.isArray(record.associated) ? record.associated : []) {
        if (entry && typeof entry.title === 'string') titles.push(entry.title);
    }
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    for (const title of titles) {
        const trimmed = title.trim();
        if (trimmed && !seen.has(trimmed.toLowerCase())) {
            seen.add(trimmed.toLowerCase());
            out.push(trimmed);
        }
    }
    return out;
}

/**
 * How well a candidate's titles match the query, 0–1, on slugs: equal is 1, containment `containmentScore`, else
 * the words' overlap (the 3.x wrapper's calculateTitleSimilarity).
 * @param {string} query
 * @param {string[]} titles
 * @param {number} containmentScore
 */
function similarity(query, titles, containmentScore) {
    const expected = toSlug(query);
    if (!expected) return 0;
    let best = 0;
    for (const title of titles) {
        const candidate = toSlug(title);
        if (!candidate) continue;
        if (candidate === expected) return 1;
        let score;
        if (candidate.includes(expected) || expected.includes(candidate)) score = containmentScore;
        else {
            const a = new Set(expected.split('-').filter(Boolean));
            const b = new Set(candidate.split('-').filter(Boolean));
            const shared = [...a].filter((w) => b.has(w)).length;
            const union = new Set([...a, ...b]).size;
            score = union ? Math.min(0.99, shared / union) : 0;
        }
        best = Math.max(best, score);
    }
    return best;
}

/**
 * The search rows ranked against the query: exact first, then by similarity, then the site's order; each with its
 * similarity and its match type against `search.fuzzyThreshold`.
 * @param {string} query
 * @param {any[]} rows
 * @param {{ fuzzyThreshold: number, containmentScore: number }} policy
 * @returns {Array<{ row: any, similarity: number, matchType: 'exact' | 'fuzzy' | 'search' }>}
 */
function rankRows(query, rows, policy) {
    return rows
        .map((row, index) => {
            const score = similarity(query, rowTitles(row), policy.containmentScore);
            /** @type {'exact' | 'fuzzy' | 'search'} */
            const matchType = score === 1 ? 'exact' : score >= policy.fuzzyThreshold ? 'fuzzy' : 'search';
            return { row, similarity: score, matchType, index };
        })
        .sort((a, b) => (b.similarity - a.similarity) || (a.index - b.index))
        .map(({ row, similarity: score, matchType }) => ({ row, similarity: score, matchType }));
}

/**
 * The settings `search.*` the ranking reads.
 * @param {Record<string, unknown>} settings
 */
function searchPolicy(settings) {
    const num = (/** @type {string} */ key, /** @type {number} */ fallback) => {
        const v = Number(settings[key]);
        return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    return {
        fuzzyThreshold: num('search.fuzzyThreshold', 0.6),
        containmentScore: num('search.containmentScore', 0.85),
        candidateLimit: Math.trunc(num('search.candidateLimit', 5)),
        exactMatchPolicy: settings['search.exactMatchPolicy'] === 'highestScore' ? 'highestScore' : 'first',
    };
}

/**
 * @param {{ settings: Record<string, unknown>, utils: Record<string, any>, addNormalizer: (fn: (response: any) => void) => void }} deps
 */
function createClient({ settings, utils, addNormalizer }) {
    addNormalizer(htmlNormalizer);
    const ttl = (/** @type {string} */ key, /** @type {number} */ fallback) => Number(settings[`cache.ttl.${key}`]) || fallback;
    const perPageSetting = Number(settings['api.endpoints.listSearch.perPage']);
    const perPage = Number.isFinite(perPageSetting) && perPageSetting > 0 ? Math.trunc(perPageSetting) : 100;
    const policy = searchPolicy(settings);
    /** @param {unknown} q */
    const sanitize = (q) => (utils && typeof utils.sanitizeForSearch === 'function' ? utils.sanitizeForSearch(String(q)) : toSlug(String(q)));

    /** @param {any} view */
    return (view) => {
        const http = view.http;
        const cache = view.cache;
        /** @param {Record<string, any>} config */
        const authed = (config) => http.authedRequest({ ...config, headers: { 'Content-Type': 'application/json', ...(config.headers || {}) } });

        /**
         * The series detail, from the cache when fresh (per scope), unless `fresh`.
         * @param {string | number} id
         * @param {{ fresh?: boolean }} [options]
         * @returns {Promise<any>}
         */
        async function series(id, options = {}) {
            const seriesId = Number(id);
            if (!Number.isFinite(seriesId) || seriesId <= 0) {
                throw new PluginError('not_found', `'${id}' is not a MangaUpdates series id`);
            }
            const key = `series:${seriesId}`;
            if (!options.fresh) {
                const cached = await cache.get(key);
                if (cached && typeof cached === 'object') return cached;
            }
            const body = (await authed({ method: 'get', url: endpoint(settings, 'series', { series_id: seriesId }), endpoint: 'series' })).data;
            if (!body || typeof body !== 'object' || body.series_id === undefined) {
                throw new PluginError('not_found', `MangaUpdates has no series ${seriesId}`);
            }
            await cache.set(key, body, ttl('seriesMetadata', 86400));
            return body;
        }

        /**
         * One title search, from the cache when fresh (per scope) unless `refresh`.
         * @param {string} query
         * @param {{ refresh?: boolean } | null} [options]
         * @returns {Promise<{ query: string, rows: any[], fetchedAt: string | null, cached: boolean }>}
         */
        async function searchRows(query, options) {
            const q = typeof query === 'string' ? query.trim() : '';
            if (!q) return { query: q, rows: [], fetchedAt: null, cached: false };
            const key = `search:${sanitize(q)}`;
            if (!(options && options.refresh === true)) {
                const hit = /** @type {any} */ (await cache.get(key));
                if (hit && Array.isArray(hit.rows) && hit.rows.length) {
                    return { query: q, rows: hit.rows, fetchedAt: typeof hit.fetchedAt === 'string' ? hit.fetchedAt : null, cached: true };
                }
            }
            const body = (await authed({
                method: 'post',
                url: endpoint(settings, 'seriesSearch'),
                data: { search: q, stype: 'title', type: ['manga', 'manhua', 'manhwa'], perpage: 25 },
                endpoint: 'seriesSearch',
                timeoutKind: 'search',
            })).data;
            const rows = body && Array.isArray(body.results) ? body.results : (Array.isArray(body) ? body : []);
            const fetchedAt = new Date().toISOString();
            if (rows.length) await cache.set(key, { rows, fetchedAt }, ttl('searchResults', 3600));
            return { query: q, rows, fetchedAt, cached: false };
        }

        /**
         * A user's lists are read only with that user's credential: a cache hit would otherwise skip the
         * authenticated request that refuses a call without one (F3: never a silent answer).
         */
        function requireCredential() {
            if (view.credential === null || view.credential === undefined) {
                throw new PluginError('credential_rejected', 'no MangaUpdates credential was presented for a read of the lists of a user');
            }
        }

        /**
         * The account's lists (list-of-lists), cached per scope (a series write never changes it), unless `fresh`.
         * @param {{ fresh?: boolean }} [options]
         * @returns {Promise<any[]>}
         */
        async function lists(options = {}) {
            requireCredential();
            const key = 'lists';
            if (!options.fresh) {
                const cached = await cache.get(key);
                if (Array.isArray(cached)) return cached;
            }
            const body = (await authed({ method: 'get', url: endpoint(settings, 'getUserLists'), endpoint: 'getUserLists' })).data;
            const all = Array.isArray(body) ? body : (body && Array.isArray(body.results) ? body.results : []);
            const out = all.filter((/** @type {any} */ l) => l && typeof l === 'object' && typeof l.list_id === 'number');
            await cache.set(key, out, ttl('userLists', 1800));
            return out;
        }

        /**
         * Every series on one list, every page, cached per scope until a write to that list clears it.
         * @param {number} listId
         * @returns {Promise<any[]>}
         */
        async function listSeries(listId) {
            requireCredential();
            const key = `list-series:${listId}`;
            const cached = await cache.get(key);
            if (Array.isArray(cached)) return cached;
            /** @type {any[]} */
            const rows = [];
            for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
                const body = (await authed({ method: 'post', url: endpoint(settings, 'listSearch', { list_id: listId }), data: { page, perpage: perPage }, endpoint: 'listSearch' })).data;
                const results = body && Array.isArray(body.results) ? body.results : [];
                rows.push(...results);
                if (results.length === 0) break;
                const total = body && typeof body.total_hits === 'number' ? body.total_hits : null;
                if (total !== null ? rows.length >= total : results.length < perPage) break;
            }
            await cache.set(key, rows, ttl('readingLists', 1800));
            return rows;
        }

        /** A write to these lists made their cached reads stale. @param {...(number | null | undefined)} listIds */
        async function invalidateLists(...listIds) {
            for (const listId of new Set(listIds)) {
                if (typeof listId === 'number') await cache.delete(`list-series:${listId}`);
            }
        }

        /**
         * Which list a series is on, or null when on none (404). Always asked of the site: a sync reads it fresh.
         * @param {number} seriesId
         * @returns {Promise<any | null>}
         */
        async function membership(seriesId) {
            try {
                const body = (await authed({ method: 'get', url: endpoint(settings, 'listGetSeriesItem', { series_id: seriesId }), endpoint: 'listGetSeriesItem' })).data;
                return body && typeof body === 'object' && typeof body.list_id === 'number' ? body : null;
            } catch (error) {
                if (isNotFound(error)) return null;
                throw error;
            }
        }

        /**
         * The list a subscribe() status names: a list type token → the account's list of that type (its own typed
         * list before a custom one); a list id (the host's custom-list override, contract §2.2) → that list.
         * @param {string | number} status
         */
        async function targetList(status) {
            const all = await lists();
            const asId = typeof status === 'number' ? status : (/^\d+$/.test(String(status).trim()) ? Number(status) : NaN);
            if (Number.isFinite(asId)) {
                const byId = all.find((l) => l.list_id === asId) || (await lists({ fresh: true })).find((l) => l.list_id === asId);
                if (!byId) throw new PluginError('not_found', `this MangaUpdates account has no list ${asId}`);
                return byId;
            }
            const token = String(status);
            if (!LIST_TYPES.includes(token)) {
                throw new PluginError('source_error', `'${token}' is neither a MangaUpdates list type (${LIST_TYPES.join(', ')}) nor a list id`);
            }
            const ofType = all.filter((l) => l.type === token);
            const target = ofType.find((l) => l.custom !== true) || ofType[0];
            if (!target) throw new PluginError('not_found', `this MangaUpdates account has no '${token}' list`);
            return target;
        }

        /** @param {string | number} id */
        function seriesIdOf(id) {
            const n = Number(id);
            if (!Number.isFinite(n) || n <= 0) throw new PluginError('not_found', `'${id}' is not a MangaUpdates series id`);
            return n;
        }

        /** @param {number} seriesId @returns {Promise<number | null>} */
        async function rating(seriesId) {
            try {
                const body = (await authed({ method: 'get', url: endpoint(settings, 'updateSerieRating', { series_id: seriesId }), endpoint: 'updateSerieRating' })).data;
                return body && typeof body.rating === 'number' ? body.rating : null;
            } catch (error) {
                if (isNotFound(error)) return null;
                throw error;
            }
        }

        return {
            /** One title search; the answer carries the `search.*` policy the mapping ranks by. @param {string} query @param {{ refresh?: boolean } | null} [options] */
            search: async (query, options) => ({ ...(await searchRows(query, options)), policy }),
            /** @param {string} id */
            lookup: (id) => series(id),
            /** @param {string} id */
            enrich: (id) => series(id),
            /**
             * Id mode fetches the known series; title mode searches and takes the best exact or fuzzy match (the 3.x
             * cover search), or nothing. @param {{ title?: string }} query @param {{ pluginEntryId?: string } | null} [options]
             */
            async searchCovers(query, options) {
                if (options && options.pluginEntryId) return series(options.pluginEntryId);
                const found = await searchRows(query && query.title ? query.title : '');
                const best = rankRows(found.query, found.rows, policy)[0];
                if (!best || best.matchType === 'search') return null;
                const id = best.row && best.row.record ? best.row.record.series_id : null;
                return id !== null && id !== undefined ? series(id) : null;
            },
            /** coverId is the series id (the 3.x `<id>/<file>` form is accepted). @param {string} coverId */
            async downloadCover(coverId) {
                const seriesId = Number(String(coverId || '').split('/')[0]);
                if (!Number.isFinite(seriesId) || seriesId <= 0) {
                    throw new PluginError('not_found', `MangaUpdates cover id '${coverId}' names no series`);
                }
                const key = `cover-bytes:${seriesId}`;
                const cached = await cache.get(key);
                if (typeof cached === 'string' && cached) return Buffer.from(cached, 'base64');
                const url = coverUrlOf(await series(seriesId));
                if (!url) throw new PluginError('not_found', `MangaUpdates series ${seriesId} has no cover`);
                const bytes = toBuffer((await http.get(url, { responseType: 'arraybuffer', endpoint: 'coverImage' })).data);
                await cache.set(key, bytes.toString('base64'), ttl('coverUrls', 604800));
                return bytes;
            },
            /**
             * The series' list membership, the list it is on (its type is the token) and the user's rating; a series
             * on no list is all-null. A failed rating read does not fail the pull (the 3.x behaviour).
             * @param {string} id
             */
            async pullProgress(id) {
                const seriesId = seriesIdOf(id);
                const entry = await membership(seriesId);
                if (!entry) return { entry: null, list: null, rating: null };
                // A list made since the list-of-lists was cached is found by asking again.
                const list = (await lists()).find((l) => l.list_id === entry.list_id)
                    || (await lists({ fresh: true })).find((l) => l.list_id === entry.list_id)
                    || null;
                let userRating = null;
                try {
                    userRating = await rating(seriesId);
                } catch {
                    userRating = null;
                }
                return { entry, list, rating: userRating };
            },
            /**
             * Chapter and volume on the series' current list (integers, positive only, as the site holds them), the
             * rating on its own endpoint (0 clears it: the host's 0 is "no rating"). Never moves the series between
             * lists. A series on no list is `not_found`: subscribe first.
             * @param {{ pluginEntryId: string, chapter?: number, volume?: number, rating?: number }} entry
             * @returns {Promise<{ chapter?: number, volume?: number, rating?: number }>}
             */
            async pushProgress(entry) {
                const seriesId = seriesIdOf(entry.pluginEntryId);
                const current = await membership(seriesId);
                if (!current) throw new PluginError('not_found', `MangaUpdates series ${seriesId} is on none of this account's lists; subscribe it first`);
                /** @type {{ chapter?: number, volume?: number, rating?: number }} */
                const sent = {};
                /** @type {Record<string, number>} */
                const status = {};
                if (typeof entry.chapter === 'number' && entry.chapter > 0) status.chapter = sent.chapter = Math.floor(entry.chapter);
                if (typeof entry.volume === 'number' && entry.volume > 0) status.volume = sent.volume = Math.floor(entry.volume);
                if (Object.keys(status).length) {
                    const response = await authed({
                        method: 'post',
                        url: endpoint(settings, 'listUpdateSeries'),
                        data: [{ series: { id: seriesId }, list_id: current.list_id, status }],
                        endpoint: 'listUpdateSeries',
                    });
                    assertAccepted(response, `the progress of series ${seriesId}`);
                }
                if (typeof entry.rating === 'number' && entry.rating >= 0) {
                    const url = endpoint(settings, 'updateSerieRating', { series_id: seriesId });
                    if (entry.rating === 0) {
                        try {
                            await authed({ method: 'delete', url, endpoint: 'updateSerieRating' });
                        } catch (error) {
                            if (!isNotFound(error)) throw error; // already unrated
                        }
                    } else {
                        assertAccepted(await authed({ method: 'put', url, data: { rating: Number(entry.rating) }, endpoint: 'updateSerieRating' }), `the rating of series ${seriesId}`);
                    }
                    sent.rating = Number(entry.rating);
                }
                // The list read carries chapter and rating: it is re-read next time.
                if (Object.keys(sent).length) await invalidateLists(current.list_id);
                return sent;
            },
            /**
             * Every series on every list of the account, each list read whole, page by page.
             * @returns {Promise<Array<{ list: any, rows: any[] }>>}
             */
            async getReadingList() {
                /** @type {Array<{ list: any, rows: any[] }>} */
                const out = [];
                for (const list of await lists()) out.push({ list, rows: await listSeries(list.list_id) });
                return out;
            },
            /**
             * Put the series on the list `status` names (a list type, or a list id from the host's custom-list
             * override): added when on no list, moved when on another. The lists it touched are re-read next time.
             * @param {{ pluginEntryId: string, status: string }} entry
             * @returns {Promise<{ list: any }>}
             */
            async subscribe(entry) {
                const seriesId = seriesIdOf(entry.pluginEntryId);
                const list = await targetList(entry.status);
                const current = await membership(seriesId);
                const row = { series: { id: seriesId }, list_id: list.list_id };
                const response = current
                    ? await authed({ method: 'post', url: endpoint(settings, 'listUpdateSeries'), data: [row], endpoint: 'listUpdateSeries' })
                    : await authed({ method: 'post', url: endpoint(settings, 'listAddSeries'), data: [row], endpoint: 'listAddSeries' });
                assertAccepted(response, current ? `moving series ${seriesId} to list ${list.list_id}` : `adding series ${seriesId} to list ${list.list_id}`);
                await invalidateLists(list.list_id, current && current.list_id);
                return { list };
            },
            /**
             * The site's real removal (live-confirmed 2026-11-07): the series id posted to /lists/series/delete. On
             * no list already is success (§2: idempotent). @param {string} id
             */
            async unsubscribe(id) {
                const seriesId = Number(id);
                // An id that names no series is on no list: already removed.
                if (!Number.isFinite(seriesId) || seriesId <= 0) return {};
                const current = await membership(seriesId);
                if (!current) return {};
                const response = await authed({ method: 'post', url: endpoint(settings, 'listRemoveSeries'), data: [seriesId], endpoint: 'listRemoveSeries' });
                assertAccepted(response, `removing series ${seriesId}`);
                await invalidateLists(current.list_id);
                return {};
            },
            /** The live state: asked of the site, and the cached copy renewed. @param {string} id */
            queryLive: (id) => series(id, { fresh: true }),
            /** The series' own volatile state, never the user's lists (Decision 3). @param {string} id */
            summarizeEntries: (id) => series(id),
        };
    };
}

module.exports = {
    createClient,
    auth,
    endpoint,
    htmlNormalizer,
    coverUrlOf,
    rowTitles,
    rankRows,
    searchPolicy,
    LIST_TYPES,
};
