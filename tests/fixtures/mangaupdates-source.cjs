'use strict';

/**
 * MangaUpdates as a stub source, in the shapes of the API v1 (https://api.mangaupdates.com/openapi.yaml) and of the
 * answers the 3.x wrapper's live checks recorded (2026-07-23, 2026-11-07). An axios-shaped handler for the SDK's
 * createStubAxios().
 *
 *  - `PUT /account/login` mints `context.session_token` for a known username and password; any other is a 401.
 *  - an authenticated path (`/lists…`, `/series/{id}/rating`) needs a Bearer token this source minted and has not
 *    revoked (`revoke()` makes every token minted so far answer 401: a session that died early).
 *  - the account has the five typed lists (ids 0–4) and one custom list (101, type `read`).
 *  - a list's series are served FIXTURE_PAGE per page whatever `perpage` asks, with `total_hits`, so the three-entry
 *    Reading List is two pages and the client must page.
 *  - writes answer `{ status: 'success' }`; the membership itself is fixed (tests that need a change wrap the handler).
 */

const BASE = 'https://api.mangaupdates.com/v1';
const CDN = 'https://cdn.mangaupdates.com/image';
const ACCOUNTS = Object.freeze({ 'mu-alpha': 'alpha-pass', 'mu-beta': 'beta-pass' });
const FIXTURE_PAGE = 2;

const LISTS = Object.freeze([
    { list_id: 0, title: 'Reading List', description: '', type: 'read', icon: 'read', custom: false },
    { list_id: 1, title: 'Wish List', description: '', type: 'wish', icon: 'wish', custom: false },
    { list_id: 2, title: 'Complete List', description: '', type: 'complete', icon: 'complete', custom: false },
    { list_id: 3, title: 'Unfinished List', description: '', type: 'unfinished', icon: 'unfinished', custom: false },
    { list_id: 4, title: 'On Hold List', description: '', type: 'hold', icon: 'hold', custom: false },
    { list_id: 101, title: 'Re-reading', description: 'my custom list', type: 'read', icon: 'read', custom: true },
]);

/** series id → where it sits. */
const MEMBERSHIP = Object.freeze({
    1: { list_id: 0, chapter: 12, volume: 2, rating: 8.5, added: 1700000000 },
    2: { list_id: 0, chapter: 3, volume: null, rating: null, added: 1700000100 },
    3: { list_id: 0, chapter: 40, volume: 5, rating: 7, added: 1700000200 },
    4: { list_id: 2, chapter: 100, volume: 10, rating: 9, added: 1700000300 },
    5: { list_id: 101, chapter: 7, volume: null, rating: null, added: 1700000400 },
});

/** The whole library, as getReadingList() must return it (every list, every page). */
const LIBRARY = Object.freeze(Object.keys(MEMBERSHIP));

/** @param {number} id */
const seriesUrl = (id) => `https://www.mangaupdates.com/series/${id.toString(36)}/series-${id}`;

/** A `GET /series/{id}` answer. @param {number} id */
function series(id) {
    return {
        series_id: id,
        title: `Series ${id}`,
        url: seriesUrl(id),
        associated: [{ title: `The Series ${id}` }, { title: `シリーズ ${id}` }],
        description: 'A series.',
        image: { url: { original: `${CDN}/i${id}.jpg`, thumb: `${CDN}/thumb/i${id}.jpg` }, height: 600, width: 400 },
        type: 'Manga',
        year: '2020',
        bayesian_rating: 7.5,
        genres: [{ genre: 'Action' }, { genre: 'Drama' }],
        latest_chapter: 42,
        status: '5 Volumes (Ongoing)',
        completed: false,
        authors: [{ name: 'An Author', author_id: 1, type: 'Author' }, { name: 'An Artist', author_id: 2, type: 'Artist' }],
        publishers: [{ publisher_name: 'A Publisher', publisher_id: 3, type: 'Original', notes: '' }],
        last_updated: { timestamp: 1759276800, as_rfc3339: '2025-10-01T00:00:00+00:00', as_string: 'October 1st, 2025 12:00am UTC' },
    };
}

/** A `POST /series/search` result row. @param {number} id */
function searchRow(id) {
    const s = series(id);
    return {
        record: { series_id: id, title: s.title, url: s.url, associated: s.associated, image: s.image, type: s.type, year: s.year },
        hit_title: s.title,
        metadata: { user_list: null },
    };
}

/** A `GET /lists/series/{id}` answer, or null when on no list. @param {number} id */
function membershipOf(id) {
    const m = /** @type {Record<string, any>} */ (MEMBERSHIP)[id];
    if (!m) return null;
    return {
        series: { id, url: seriesUrl(id), title: `Series ${id}` },
        list_id: m.list_id,
        status: { volume: m.volume, chapter: m.chapter },
        priority: 0,
        time_added: { timestamp: m.added, as_rfc3339: new Date(m.added * 1000).toISOString(), as_string: '' },
    };
}

/** A `POST /lists/{id}/search` result row. @param {number} id */
function listRow(id) {
    const m = membershipOf(id);
    return { record: m, metadata: { series: { series_id: id, title: `Series ${id}` }, user_rating: /** @type {any} */ (MEMBERSHIP)[id].rating } };
}

/**
 * A fresh source with its own minted sessions.
 */
function createSource() {
    let minted = 0;
    /** @type {Map<string, string>} token → username */
    const sessions = new Map();
    /** @type {Set<string>} */
    const revoked = new Set();
    /** @type {string[]} usernames, in login order */
    const logins = [];

    /**
     * @param {Record<string, any>} config
     * @returns {{ status: number, data?: unknown, headers?: Record<string, string> }}
     */
    function handler(config) {
        const url = String(config.url || '');
        const method = String(config.method || 'get').toLowerCase();
        const path = (url.startsWith(BASE) ? url.slice(BASE.length) : url).split('?')[0];
        const data = config.data;

        if (path === '/account/login' && method === 'put') {
            const username = data && data.username;
            if (!username || /** @type {Record<string, string>} */ (ACCOUNTS)[username] !== data.password) {
                return { status: 401, data: { status: 'exception', reason: 'Invalid username or password.' } };
            }
            minted += 1;
            const token = `session-${username}-${minted}`;
            sessions.set(token, username);
            logins.push(username);
            return { status: 200, data: { status: 'success', reason: 'Successfully logged in.', context: { session_token: token, uid: minted } } };
        }

        if (url.startsWith(CDN)) return { status: 200, data: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'image/jpeg' } };

        const authorization = config.headers && config.headers.Authorization ? String(config.headers.Authorization) : '';
        const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        const signedIn = sessions.has(token) && !revoked.has(token);
        const needsSession = path.startsWith('/lists') || /^\/series\/\d+\/rating$/.test(path);
        if (needsSession && !signedIn) return { status: 401, data: { status: 'exception', reason: 'You must be logged in.' } };

        if (path === '/lists' && method === 'get') return { status: 200, data: LISTS };
        const listSearch = path.match(/^\/lists\/(\d+)\/search$/);
        if (listSearch && method === 'post') {
            const listId = Number(listSearch[1]);
            const ids = Object.keys(MEMBERSHIP).map(Number).filter((id) => /** @type {any} */ (MEMBERSHIP)[id].list_id === listId);
            const page = Number(data && data.page) || 1;
            const perPage = Math.min(Number(data && data.perpage) || 100, FIXTURE_PAGE);
            const slice = ids.slice((page - 1) * perPage, page * perPage);
            return { status: 200, data: { total_hits: ids.length, page, per_page: perPage, results: slice.map(listRow) } };
        }
        if (path === '/lists/series' && method === 'post') return { status: 200, data: { status: 'success', reason: 'Series added.' } };
        if (path === '/lists/series/update' && method === 'post') return { status: 200, data: { status: 'success', reason: 'Series updated.' } };
        if (path === '/lists/series/delete' && method === 'post') return { status: 200, data: { status: 'success', reason: 'Series removed.' } };
        const listItem = path.match(/^\/lists\/series\/(\d+)$/);
        if (listItem && method === 'get') {
            const m = membershipOf(Number(listItem[1]));
            return m ? { status: 200, data: m } : { status: 404, data: { status: 'exception', reason: 'Series not found on any list.' } };
        }

        const rating = path.match(/^\/series\/(\d+)\/rating$/);
        if (rating) {
            const m = /** @type {any} */ (MEMBERSHIP)[Number(rating[1])];
            if (method === 'get') {
                return m && typeof m.rating === 'number'
                    ? { status: 200, data: { rating: m.rating, last_updated: { timestamp: m.added } } }
                    : { status: 404, data: { status: 'exception', reason: 'No rating.' } };
            }
            return { status: 200, data: { status: 'success', reason: 'Rating updated.' } };
        }

        if (path === '/series/search' && method === 'post') {
            const q = String(data && data.search || '').toLowerCase();
            const ids = q.includes('series 1') ? [1, 12] : q.includes('nothing') ? [] : [1];
            return { status: 200, data: { total_hits: ids.length, page: 1, per_page: 25, results: ids.map(searchRow) } };
        }
        const detail = path.match(/^\/series\/(\d+)$/);
        if (detail && method === 'get') {
            const id = Number(detail[1]);
            return id >= 900 ? { status: 404, data: { status: 'exception', reason: 'Series not found.' } } : { status: 200, data: series(id) };
        }
        return { status: 404, data: { status: 'exception', reason: `no such route: ${method} ${path}` } };
    }

    return {
        handler,
        logins,
        /** Every session minted so far dies (the site answers 401 to it). */
        revoke() {
            for (const token of sessions.keys()) revoked.add(token);
        },
    };
}

const defaultSource = createSource();

module.exports = {
    sourceHandler: defaultSource.handler,
    createSource,
    BASE,
    CDN,
    ACCOUNTS,
    LISTS,
    MEMBERSHIP,
    LIBRARY,
    FIXTURE_PAGE,
    series,
    searchRow,
    listRow,
    membershipOf,
};
