'use strict';

/**
 * L3b — MangaUpdates' mapping: MAP (Plan-2026Q4-tracker-plugin-standardization §1.2). Pure functions: MangaUpdates'
 * shapes in, the contract's DTOs out (host-capability-contract.md §2, §2.6). One function per contract method,
 * named after it. The status token is the MangaUpdates list's `type` (read, wish, complete, unfinished, hold —
 * Decision 2) and `listId` the list's id: the host resolves both (§2.2), the custom-list override by `listId`
 * first; the plugin never maps to the host's statuses.
 *
 * Folds in the 3.x wrapper's inline normalizers (`_normalizeSeriesData`, `_mapSearchResult`, `_mapSeriesStatus`)
 * and its orphaned mapper (`mapper-mangaupdates.cjs`: contributor roles, the year fallbacks).
 */

const { markCached } = require('@manga-list/plugin-sdk');
const { coverUrlOf, rowTitles, rankRows, LIST_TYPES } = require('./client-mangaupdates.cjs');

const SITE_ID = 'mangaupdates';
const SITE_LABEL = 'MangaUpdates';

/** @param {unknown} value @returns {string | null} */
function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A list's type as the token, when it is one MangaUpdates defines. @param {any} list @returns {string | null} */
function listToken(list) {
    return list && typeof list.type === 'string' && LIST_TYPES.includes(list.type) ? list.type : null;
}

/** MangaUpdates' Unix-seconds `{ timestamp }` → ISO. @param {any} time @returns {string | null} */
function isoOf(time) {
    if (time && typeof time === 'object') {
        if (typeof time.timestamp === 'number' && Number.isFinite(time.timestamp)) return new Date(time.timestamp * 1000).toISOString();
        if (typeof time.as_rfc3339 === 'string' && time.as_rfc3339) return time.as_rfc3339;
    }
    return null;
}

/** @param {...unknown} values @returns {number | null} */
function yearOf(...values) {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
        if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value.trim()))) return Math.trunc(Number(value.trim()));
    }
    return null;
}

/** The series' publication status → the contribution's closed set. @param {any} raw */
function seriesStatus(raw) {
    if (raw && raw.completed === true) return 'completed';
    const s = typeof (raw && raw.status) === 'string' ? raw.status.toLowerCase() : '';
    if (s.includes('complete')) return 'completed';
    if (s.includes('hiatus')) return 'hiatus';
    if (s.includes('ongoing') || s.includes('publish')) return 'ongoing';
    return 'unknown';
}

/** Every associated title, the primary left out, no duplicates. @param {any} raw @returns {string[]} */
function altTitles(raw) {
    const primary = text(raw && raw.title);
    /** @type {string[]} */
    const out = [];
    for (const entry of raw && Array.isArray(raw.associated) ? raw.associated : []) {
        const title = text(entry && entry.title);
        if (title && title !== primary && !out.includes(title)) out.push(title);
    }
    return out;
}

/**
 * Contributors with their MangaUpdates role, the first of a name kept; a publisher's "Publisher" role is the
 * original publisher (the 3.x mapper's canonicalization).
 * @param {unknown} entries
 * @param {string} nameKey
 * @param {boolean} publisher
 * @returns {Array<{ name: string, type?: string }>}
 */
function contributors(entries, nameKey, publisher) {
    /** @type {Array<{ name: string, type?: string }>} */
    const out = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
        const name = text(entry && (entry[nameKey] ?? entry.name));
        if (!name || out.some((c) => c.name.toLowerCase() === name.toLowerCase())) continue;
        let type = text(entry.type) || text(entry.role);
        if (publisher && type && type.toLowerCase() === 'publisher') type = 'Original';
        out.push(type ? { name, type } : { name });
    }
    return out;
}

/** @param {any} raw */
function contribution(raw) {
    /** @type {Record<string, any>} */
    const out = { pluginEntryId: String(raw.series_id), syncedAt: new Date().toISOString(), seriesStatus: seriesStatus(raw) };
    const title = text(raw.title);
    if (title) out.displayTitle = title;
    const alts = altTitles(raw);
    if (alts.length) out.altTitles = alts;
    const authors = contributors(raw.authors, 'name', false);
    if (authors.length) out.authors = authors;
    const genres = (Array.isArray(raw.genres) ? raw.genres : []).map((/** @type {any} */ g) => text(g && (g.genre ?? g))).filter(Boolean);
    if (genres.length) out.genres = genres;
    const description = text(raw.description);
    if (description) out.description = description;
    const cover = coverUrlOf(raw);
    if (cover) out.coverUrl = cover;
    const year = yearOf(raw.year, raw.year_released, raw.release_year);
    if (year !== null) out.year = year;
    const type = text(raw.type);
    if (type) out.seriesType = type;
    const publishers = contributors(raw.publishers, 'publisher_name', true);
    if (publishers.length) out.publishers = publishers;
    const url = text(raw.url);
    out.sourceLinks = url ? [{ siteId: SITE_ID, siteLabel: SITE_LABEL, seriesUrl: url, isPrimary: true }] : [];
    return out;
}

/** The user's 0–10 rating as MangaUpdates holds it. @param {unknown} rating */
const ratingOf = (rating) => (typeof rating === 'number' && Number.isFinite(rating) ? rating : null);

/**
 * MangaUpdates' word for the series' state, from its status text ("12 Volumes (Ongoing)" → "ongoing"), or
 * "complete" from its `completed` flag. @param {any} raw @returns {string | null}
 */
function seriesStateWord(raw) {
    const status = text(raw && raw.status);
    const word = status ? status.match(/\(([^()]+)\)\s*$/) : null;
    if (word && word[1].trim()) return word[1].trim().toLowerCase();
    return raw && raw.completed === true ? 'complete' : null;
}

/**
 * @param {any} row - a /lists/{id}/search result: `{ record: { series, list_id, status, priority, time_added }, metadata: { user_rating } }`
 * @param {any} list
 */
function readingListEntry(row, list) {
    const record = row && row.record && typeof row.record === 'object' ? row.record : null;
    const series = record && record.series && typeof record.series === 'object' ? record.series : null;
    if (!series || series.id === undefined || series.id === null) return null;
    const progress = record.status && typeof record.status === 'object' ? record.status : {};
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    return {
        pluginEntryId: String(series.id),
        title: text(series.title),
        canonicalUrl: text(series.url),
        status: listToken(list),
        chapter: typeof progress.chapter === 'number' ? progress.chapter : null,
        rating: ratingOf(metadata.user_rating),
        volume: typeof progress.volume === 'number' ? progress.volume : null,
        listId: typeof list.list_id === 'number' ? list.list_id : null,
        priority: typeof record.priority === 'number' ? record.priority : null,
        lastUpdated: isoOf(record.time_added),
    };
}

module.exports = {
    /**
     * Candidates ranked against the query, confidence 0–1. With `search.exactMatchPolicy` 'first', an exact match
     * answers alone (the 3.x search's behaviour); otherwise the best `search.candidateLimit`.
     * @param {{ query: string, rows: any[], fetchedAt: string | null, cached: boolean, policy: { fuzzyThreshold: number, containmentScore: number, candidateLimit: number, exactMatchPolicy: string } }} found
     */
    search(found) {
        const ranked = rankRows(found.query, found.rows.filter((r) => r && r.record && r.record.series_id !== undefined && r.record.series_id !== null), found.policy);
        const exact = ranked.filter((r) => r.matchType === 'exact');
        const kept = found.policy.exactMatchPolicy === 'first' && exact.length ? exact : ranked.slice(0, Math.max(1, found.policy.candidateLimit));
        return kept.map(({ row, similarity }) => {
            const record = row.record;
            const title = text(record.title) || text(row.hit_title) || '';
            const candidate = {
                pluginEntryId: String(record.series_id),
                title,
                altTitles: rowTitles(row).filter((t) => t !== title),
                confidence: Math.round(similarity * 100) / 100,
                canonicalUrl: text(record.url),
            };
            return found.cached ? markCached(candidate, found.fetchedAt) : candidate;
        });
    },
    /** @param {any} raw */
    lookup: (raw) => ({ ...contribution(raw), canonicalUrl: text(raw.url) }),
    /** @param {any} raw */
    enrich: (raw) => ({ contribution: contribution(raw) }),
    /** The series' one cover (CDN-assigned), or none. @param {any} raw */
    searchCovers(raw) {
        const url = coverUrlOf(raw);
        if (!raw || !url) return [];
        const image = raw.image && typeof raw.image === 'object' ? raw.image : {};
        const thumb = image.url && typeof image.url.thumb === 'string' ? image.url.thumb : undefined;
        return [{
            coverId: String(raw.series_id),
            imageUrl: url,
            ...(thumb ? { thumbnailUrl: thumb } : {}),
            ...(typeof image.width === 'number' ? { width: image.width } : {}),
            ...(typeof image.height === 'number' ? { height: image.height } : {}),
        }];
    },
    /** @param {{ entry: any | null, list: any | null, rating: number | null }} raw @param {string} id */
    pullProgress(raw, id) {
        const entry = raw && raw.entry;
        const progress = entry && entry.status && typeof entry.status === 'object' ? entry.status : {};
        return {
            pluginEntryId: String(id),
            status: entry ? listToken(raw.list) : null,
            chapter: entry && typeof progress.chapter === 'number' ? progress.chapter : null,
            rating: entry ? ratingOf(raw.rating) : null,
            lastUpdated: entry ? isoOf(entry.time_added) : null,
        };
    },
    /** What landed, on the host's scale (the same: chapter integer, rating 0–10). @param {{ chapter?: number, rating?: number }} sent */
    pushProgress: (sent) => ({
        applied: {
            ...(typeof sent.chapter === 'number' ? { chapter: sent.chapter } : {}),
            ...(typeof sent.rating === 'number' ? { rating: sent.rating } : {}),
        },
    }),
    /** @param {Array<{ list: any, rows: any[] }>} lists */
    getReadingList(lists) {
        /** @type {any[]} */
        const out = [];
        for (const { list, rows } of lists) {
            for (const row of rows) {
                const entry = readingListEntry(row, list);
                if (entry) out.push(entry);
            }
        }
        return out;
    },
    /** The list the series landed on: its type is the token as applied. @param {{ list: any }} out */
    subscribe: (out) => ({ listId: typeof out.list.list_id === 'number' ? out.list.list_id : null, status: listToken(out.list) }),
    /** @param {any} raw @param {string} id */
    queryLive(raw, id) {
        const url = text(raw.url);
        const status = text(raw.status);
        return {
            status: 'ok',
            data: {
                pluginEntryId: String(id),
                displayTitle: text(raw.title) || undefined,
                statusLabel: status || undefined,
                fetchedAt: new Date().toISOString(),
                sections: [
                    {
                        type: 'stat-grid',
                        label: 'Overview',
                        fields: [
                            { label: 'Series status', value: status || '—' },
                            { label: 'Type', value: text(raw.type) || '—' },
                            { label: 'Year', value: yearOf(raw.year) ?? '—' },
                            { label: 'Latest chapter', value: typeof raw.latest_chapter === 'number' ? raw.latest_chapter : '—' },
                            { label: 'Alt titles', value: altTitles(raw).length },
                        ],
                    },
                    ...(url ? [{ type: 'link-list', label: 'Links', links: [{ label: SITE_LABEL, url }] }] : []),
                ],
            },
        };
    },
    /**
     * The series' volatile state (A4) from its own record: its status text as the label, MangaUpdates' state word
     * as the status, its latest chapter and last update. Never the user's lists, never a link state.
     * @param {any} raw
     */
    summarizeEntries: (raw) => ({
        summary: {
            label: text(raw.status),
            status: seriesStateWord(raw),
            latestChapter: typeof raw.latest_chapter === 'number' ? raw.latest_chapter : null,
            lastUpdated: isoOf(raw.last_updated),
        },
    }),
    // exposed for the mapping tests
    _seriesStatus: seriesStatus,
    _contributors: contributors,
};
