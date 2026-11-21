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
 *  - `POST /series/search` answers in the openapi's shape (`SeriesSearchResponseV1`): a short record per hit, the
 *    matched title, and `metadata.user_list`, the searching account's own entry. It honours `perpage` and the `type`
 *    include filter, so the filtered search (manga, manhua, manhwa; 25) and the every-hit one (A35: no type, the result
 *    cap) answer differently: *Series 1* finds a novel only without the filter, *Many* holds 40 hits.
 *  - series NOVEL_ID is a novel; CANCELLED_ID is a cancelled series whose status text runs over several lines (A34).
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

/** The novel *Series 1* finds only without the type filter. */
const NOVEL_ID = 40;
/** A cancelled series, its status text over several lines (card brief §9.2's shape). */
const CANCELLED_ID = 41;
/** The series ids the query *Many* finds: more than the filtered search keeps, more than a small result cap. */
const MANY_IDS = Object.freeze(Array.from({ length: 40 }, (_, i) => 100 + i));

/** A `GET /series/{id}` answer (`SeriesModelV1`). @param {number} id */
function series(id) {
    const base = {
        series_id: id,
        title: id === NOVEL_ID ? 'Series 1 (Novel)' : `Series ${id}`,
        url: seriesUrl(id),
        associated: [{ title: `The Series ${id}` }, { title: `シリーズ ${id}` }],
        description: 'A series.',
        image: { url: { original: `${CDN}/i${id}.jpg`, thumb: `${CDN}/thumb/i${id}.jpg` }, height: 600, width: 400 },
        type: id === NOVEL_ID ? 'Novel' : 'Manga',
        year: '2020',
        bayesian_rating: 7.5,
        rating_votes: 651,
        genres: [{ genre: 'Action' }, { genre: 'Drama' }],
        categories: [
            { series_id: id, category: 'Adapted to Anime', votes: 5, votes_plus: 7, votes_minus: 2, added_by: 1 },
            { series_id: id, category: 'Elf', votes: 3, votes_plus: 3, votes_minus: 0, added_by: 1 },
        ],
        latest_chapter: 42,
        forum_id: 1,
        status: '5 Volumes (Ongoing)',
        licensed: true,
        completed: false,
        anime: { start: 'Vol 1, Chap 1 (S1)', end: 'Vol 7, Chap 60 (S1)' },
        related_series: [{ relation_id: 1, relation_type: 'Spin-Off', related_series_id: 77, related_series_name: 'Series 77', related_series_url: seriesUrl(77), triggered_by_relation_id: 0 }],
        authors: [{ name: 'An Author', author_id: 1, type: 'Author' }, { name: 'An Artist', author_id: 2, type: 'Artist' }],
        publishers: [{ publisher_name: 'A Publisher', publisher_id: 3, type: 'Original', notes: '' }],
        publications: [{ publication_name: 'A Weekly Magazine', publisher_name: 'A Publisher', publisher_id: 3 }],
        recommendations: [{ series_name: 'Series 78', series_url: seriesUrl(78), series_id: 78, series_image: {}, weight: 3 }],
        category_recommendations: [
            { series_name: 'Series 78', series_url: seriesUrl(78), series_id: 78, series_image: {}, weight: 2 },
            { series_name: 'Series 79', series_url: seriesUrl(79), series_id: 79, series_image: {}, weight: 1 },
        ],
        rank: {
            position: { week: 26, month: 22, three_months: 32, six_months: 31, year: 26 },
            old_position: { week: 27, month: 20, three_months: 30, six_months: 33, year: 28 },
            lists: { reading: 3841, wish: 920, complete: 44, unfinished: 83, custom: 477 },
        },
        last_updated: { timestamp: 1759276800, as_rfc3339: '2025-10-01T00:00:00+00:00', as_string: 'October 1st, 2025 12:00am UTC' },
        admin: { approved: true },
    };
    if (id !== CANCELLED_ID) return base;
    // What a series without a rating, rank, anime, categories or relations answers: empty values, which the mapping
    // treats as not held.
    return {
        ...base,
        title: 'A Cancelled Series',
        description: '<i>From a publisher</i>: a series.<BR><BR>In two parts &amp; more.',
        status: '12 Chapters (Cancelled)\nS1: 8 Chapters (1-8)\nS2: 4 Chapters (9-12',
        licensed: false,
        anime: { start: '', end: '' },
        categories: [],
        related_series: [],
        recommendations: [],
        category_recommendations: [],
        publications: [],
        rank: { position: { week: 0 }, lists: {} },
        bayesian_rating: 0,
        rating_votes: 0,
    };
}

/** The searching account's own entry, which a search answer carries (the system account's, under a system search). */
const SYSTEM_USER_LIST = Object.freeze({ series: { id: 1 }, list_id: 0, list_type: 'read', list_icon: 'read', status: { volume: 2, chapter: 12 }, priority: 0, time_added: { timestamp: 1700000000 } });

/**
 * A `POST /series/search` result row (`SeriesSearchResponseV1.results[]`). `associated` is not in the openapi's
 * search record (the live sample of 2026-11-19 holds none); the row keeps it for the 3.x alias match's tests.
 * @param {number} id
 * @param {string} [hitTitle] - the title the search matched, the series' own when not given
 */
function searchRow(id, hitTitle) {
    const s = series(id);
    return {
        record: {
            series_id: id, title: s.title, url: s.url, associated: s.associated, description: s.description, image: s.image, type: s.type,
            year: s.year, bayesian_rating: s.bayesian_rating, rating_votes: s.rating_votes, genres: s.genres, last_updated: s.last_updated,
        },
        hit_title: hitTitle || s.title,
        metadata: { user_list: id === 1 ? SYSTEM_USER_LIST : null, user_genre_highlights: [] },
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
            // A series on none of the account's lists: the live site answers 404 with an empty text/html body (2026-11-08).
            return m ? { status: 200, data: m } : { status: 404, headers: { 'content-type': 'text/html; charset=UTF-8' }, data: '' };
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
            const hits = q.includes('series 1') ? [1, 12, NOVEL_ID] : q.includes('nothing') ? [] : q.includes('many') ? [...MANY_IDS]
                : q.includes('cancelled') ? [CANCELLED_ID] : [1];
            // `type` keeps the series of those types (case aside); `perpage` is the page size, the site's 25 without it.
            const types = Array.isArray(data && data.type) ? data.type.map((/** @type {string} */ t) => String(t).toLowerCase()) : null;
            const typed = types ? hits.filter((id) => types.includes(String(series(id).type).toLowerCase())) : hits;
            const perPage = Number(data && data.perpage) > 0 ? Number(data.perpage) : 25;
            const results = typed.slice(0, perPage).map((id) => searchRow(id));
            return { status: 200, data: { total_hits: typed.length, page: 1, per_page: perPage, results } };
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
    NOVEL_ID,
    CANCELLED_ID,
    MANY_IDS,
    SYSTEM_USER_LIST,
    series,
    searchRow,
    listRow,
    membershipOf,
};
