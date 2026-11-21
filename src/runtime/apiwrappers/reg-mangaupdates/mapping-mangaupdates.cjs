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

/** @typedef {import('@manga-list/plugin-sdk').PluginEntryRecord} PluginEntryRecord */
/** @typedef {import('@manga-list/plugin-sdk').PluginEntryDisplay} PluginEntryDisplay */
/** @typedef {import('@manga-list/plugin-sdk').PluginEntryDetail} PluginEntryDetail */
/** @typedef {import('@manga-list/plugin-sdk').PluginMatchCandidate} PluginMatchCandidate */
/** @typedef {import('@manga-list/plugin-sdk').PluginSeriesStatus} PluginSeriesStatus */
/** @typedef {import('@manga-list/plugin-sdk').PluginDisplayTitle} PluginDisplayTitle */
/** @typedef {import('@manga-list/plugin-sdk').PluginDisplayTag} PluginDisplayTag */
/** @typedef {import('@manga-list/plugin-sdk').PluginDisplayRelation} PluginDisplayRelation */
/** @typedef {import('@manga-list/plugin-sdk').PluginDisplayRecommendation} PluginDisplayRecommendation */
/** @typedef {import('@manga-list/plugin-sdk').PluginDisplayCoverSize} PluginDisplayCoverSize */
/** @typedef {import('./client-mangaupdates.cjs').MuSeries} MuSeries */
/** @typedef {import('./client-mangaupdates.cjs').MuSeriesSearchRecord} MuSeriesSearchRecord */
/** @typedef {import('./client-mangaupdates.cjs').MuSearchRow} MuSearchRow */
/** @typedef {import('./client-mangaupdates.cjs').MuSearchAnswer} MuSearchAnswer */
/** @typedef {import('./client-mangaupdates.cjs').MuRank} MuRank */

const SITE_ID = 'mangaupdates';
const SITE_LABEL = 'MangaUpdates';

/** MangaUpdates' ratings are on a 10 scale (openapi `bayesian_rating`; the 3.x wrapper's user rating 0–10). */
const RATING_SCALE = 10;

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

/**
 * A status text's state → the contribution's closed set, or null when the text names none.
 * @param {string} s - lower-cased
 * @returns {PluginSeriesStatus | null}
 */
function statusOfText(s) {
    // A34: cancelled is its own. "Discontinued" is read as cancelled too: unverified against a live series (no capture
    // holds a cancelled MangaUpdates series, 2026-11-20).
    if (s.includes('cancel') || s.includes('discontinu')) return 'cancelled';
    if (s.includes('complete')) return 'completed';
    if (s.includes('hiatus')) return 'hiatus';
    if (s.includes('ongoing') || s.includes('publish')) return 'ongoing';
    return null;
}

/**
 * The series' publication status → the contribution's closed set. The status text's first line is the series' own
 * (*570 Chapters (Complete)*); the lines after it are seasons or parts (card brief §9.2), read only when the first
 * names no state.
 * @param {{ status?: string, completed?: boolean } | null | undefined} raw
 * @returns {PluginSeriesStatus}
 */
function seriesStatus(raw) {
    if (raw && raw.completed === true) return 'completed';
    const s = raw && typeof raw.status === 'string' ? plainText(raw.status).toLowerCase() : '';
    return statusOfText(s.split('\n')[0]) || statusOfText(s) || 'unknown';
}

/**
 * MangaUpdates' free text as plain text, line breaks kept (contract §2.6; card brief §5 rule 12): a `<br>` is a line
 * break, other markup is dropped, the common entities decoded, and each line trimmed. The card brief §4.2 records
 * markup and line breaks in descriptions; which tags MangaUpdates uses is not captured, so every tag is handled alike.
 * @param {string} value
 * @returns {string}
 */
function plainText(value) {
    /** @type {Record<string, string>} */
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return value
        .replace(/\r\n?/g, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
            const c = String(code).toLowerCase();
            if (c.startsWith('#x')) return String.fromCodePoint(parseInt(c.slice(2), 16));
            if (c.startsWith('#')) return String.fromCodePoint(Number(c.slice(1)));
            return Object.prototype.hasOwnProperty.call(entities, c) ? entities[c] : whole;
        })
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** A held plain text, or undefined. @param {unknown} value @returns {string | undefined} */
function plainOf(value) {
    if (typeof value !== 'string') return undefined;
    const out = plainText(value);
    // Card brief §5 rule 12: a literal null or N/A is no value.
    return out && !/^(null|n\/a)$/i.test(out) ? out : undefined;
}

/** A positive count, or undefined. @param {unknown} value @returns {number | undefined} */
function positive(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Drop what the source does not hold: a field is absent, never null, '' or [] (A32); an object left with nothing in
 * it is dropped too.
 * @template {object} T
 * @param {T} obj
 * @returns {T}
 */
function held(obj) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
        if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
        out[key] = value;
    }
    // Every key of `out` is one of `obj`'s with its value unchanged; only the absent ones are left out.
    return /** @type {T} */ (out);
}

/**
 * The series' titles: its own (main), then every other it carries (alternate; MangaUpdates gives no language or
 * script). A search row's matched title (`hit_title`) is one of the series' titles, so it is among them; that it
 * matched is the host's mark, never a kind.
 * @param {MuSeriesSearchRecord} raw
 * @param {string | undefined} [hitTitle]
 * @returns {PluginDisplayTitle[]}
 */
function displayTitles(raw, hitTitle) {
    const main = text(raw.title);
    /** @type {PluginDisplayTitle[]} */
    const out = main ? [{ title: main, kind: 'main' }] : [];
    const seen = new Set(main ? [main.toLowerCase()] : []);
    const others = [hitTitle, ...(Array.isArray(raw.associated) ? raw.associated.map((a) => a && a.title) : [])];
    for (const other of others) {
        const title = text(other);
        if (title && !seen.has(title.toLowerCase())) {
            seen.add(title.toLowerCase());
            out.push({ title, kind: 'alternate' });
        }
    }
    return out;
}

/**
 * The cover's sizes: the original (with its width) and the thumbnail, each a CDN URL the series carries.
 * @param {MuSeriesSearchRecord} raw
 * @returns {PluginDisplayCoverSize[]}
 */
function coverSizes(raw) {
    const original = coverUrlOf(raw);
    if (!original) return [];
    /** @type {PluginDisplayCoverSize[]} */
    const sizes = [held({ url: original, width: positive(raw.image && raw.image.width) })];
    const thumb = coverUrlOf({ image: { url: { original: raw.image && raw.image.url ? raw.image.url.thumb : undefined } } });
    if (thumb && thumb !== original) sizes.push({ url: thumb });
    return sizes;
}

/**
 * MangaUpdates' rank and list counts (`rank`): the week's position (the first the site lists) and how many lists hold
 * the series, every list kind summed. The other periods and the previous positions have no field in the contract's
 * vocabulary (§2.6 `popularity`).
 * @param {MuRank | undefined} rank
 * @returns {import('@manga-list/plugin-sdk').PluginDisplayPopularity}
 */
function popularityOf(rank) {
    const lists = rank && rank.lists ? rank.lists : null;
    const counts = lists ? [lists.reading, lists.wish, lists.complete, lists.unfinished, lists.custom].filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) : [];
    const total = counts.reduce((/** @type {number} */ a, /** @type {number | undefined} */ b) => a + (b || 0), 0);
    return held({ rank: positive(rank && rank.position ? rank.position.week : undefined), lists: positive(total) });
}

/** The site's last update as an ISO date. @param {MuSeriesSearchRecord} raw @returns {string | undefined} */
function updatedOf(raw) {
    return isoOf(raw.last_updated) || undefined;
}

/**
 * The display part (A33) of what MangaUpdates holds for a series, from a search record or a series read alike: a
 * field the given answer does not hold is absent. Never the searching account's own data (`metadata.user_list`, card
 * brief §5 rule 11), which is no field of a series.
 * @param {MuSeries} raw
 * @param {string | undefined} [hitTitle] - a search row's matched title
 * @returns {PluginEntryDisplay}
 */
function display(raw, hitTitle) {
    const description = plainOf(raw.description);
    const rating = positive(raw.bayesian_rating);
    const votes = typeof raw.rating_votes === 'number' && Number.isFinite(raw.rating_votes) && raw.rating_votes >= 0 ? raw.rating_votes : undefined;
    /** @type {PluginDisplayTag[]} */
    const tags = [];
    for (const c of Array.isArray(raw.categories) ? raw.categories : []) {
        const name = text(c && c.category);
        if (!name) continue;
        const net = typeof c.votes === 'number' ? c.votes
            : (typeof c.votes_plus === 'number' || typeof c.votes_minus === 'number' ? (c.votes_plus || 0) - (c.votes_minus || 0) : undefined);
        tags.push(held({ name, votes: net }));
    }
    /** @type {PluginDisplayRelation[]} */
    const relations = [];
    for (const r of Array.isArray(raw.related_series) ? raw.related_series : []) {
        const relation = text(r && r.relation_type);
        if (!relation) continue;
        relations.push(held({
            relation,
            title: text(r.related_series_name) || undefined,
            pluginEntryId: typeof r.related_series_id === 'number' ? String(r.related_series_id) : undefined,
            url: text(r.related_series_url) || undefined,
        }));
    }
    /** @type {PluginDisplayRecommendation[]} */
    const recommendations = [];
    const recommended = new Set();
    // The users' recommendations, then the category-based ones; a series in both appears once.
    for (const r of [...(Array.isArray(raw.recommendations) ? raw.recommendations : []), ...(Array.isArray(raw.category_recommendations) ? raw.category_recommendations : [])]) {
        const title = text(r && r.series_name);
        const key = r && typeof r.series_id === 'number' ? r.series_id : title;
        if (!title || recommended.has(key)) continue;
        recommended.add(key);
        recommendations.push(held({
            title,
            pluginEntryId: typeof r.series_id === 'number' ? String(r.series_id) : undefined,
            url: text(r.series_url) || undefined,
        }));
    }
    const magazines = (Array.isArray(raw.publications) ? raw.publications : []).map((p) => text(p && p.publication_name)).filter((n) => !!n);
    // `anime` says where in the comic each adaptation starts and ends; empty, it says nothing (absent, never "no anime").
    const anime = raw.anime && typeof raw.anime === 'object' && (text(raw.anime.start) || text(raw.anime.end)) ? true : undefined;
    return held({
        titles: displayTitles(raw, hitTitle),
        descriptions: description ? [{ text: description }] : undefined,
        cover: held({ sizes: coverSizes(raw) }),
        statusText: plainOf(raw.status),
        dates: held({ updated: updatedOf(raw) }),
        chapters: held({ latest: positive(raw.latest_chapter) }),
        magazine: magazines.length ? magazines.join(', ') : undefined,
        tags,
        ratings: rating !== undefined && rating <= RATING_SCALE
            ? [held({ source: SITE_LABEL, value: rating, scale: RATING_SCALE, votes })]
            : undefined,
        popularity: popularityOf(raw.rank),
        licensing: held({ licensed: typeof raw.licensed === 'boolean' ? raw.licensed : undefined, anime }),
        relations,
        recommendations,
    });
}

/**
 * A32: the record a search candidate carries, as far as the search row holds it, without its identity (the
 * candidate holds `pluginEntryId`, `canonicalUrl`, `cached`, `fetchedAt`; a search invents no `syncedAt`). The row
 * carries no status: `seriesStatus` is absent, never `unknown`.
 * @param {MuSearchRow} row
 * @returns {PluginEntryRecord}
 */
function record(row) {
    /** @type {MuSeriesSearchRecord} */
    const raw = row.record || {};
    const title = text(raw.title);
    const url = text(raw.url);
    const year = yearOf(raw.year);
    return held({
        displayTitle: title || undefined,
        altTitles: rowTitles(row).filter((t) => t !== title),
        description: text(raw.description) || undefined,
        coverUrl: coverUrlOf(raw) || undefined,
        genres: genresOf(raw),
        year: year === null ? undefined : year,
        seriesType: text(raw.type) || undefined,
        sourceLinks: url ? [{ siteId: SITE_ID, siteLabel: SITE_LABEL, seriesUrl: url, isPrimary: true }] : undefined,
        display: display(raw, text(row.hit_title) || undefined),
    });
}

/** The genre names. @param {MuSeriesSearchRecord} raw @returns {string[]} */
function genresOf(raw) {
    /** @type {string[]} */
    const out = [];
    for (const g of Array.isArray(raw.genres) ? raw.genres : []) {
        const name = text(g && typeof g === 'object' ? g.genre : g);
        if (name) out.push(name);
    }
    return out;
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

/**
 * The contribution: the stable metadata Enriching stores (§2.6), unchanged by 4.4.0 but for `cancelled` (A34).
 * @param {MuSeries} raw
 * @returns {import('@manga-list/plugin-sdk').PluginLinkContribution}
 */
function contribution(raw) {
    /** @type {import('@manga-list/plugin-sdk').PluginLinkContribution} */
    const out = { pluginEntryId: String(raw.series_id), syncedAt: new Date().toISOString(), seriesStatus: seriesStatus(raw) };
    const title = text(raw.title);
    if (title) out.displayTitle = title;
    const alts = altTitles(raw);
    if (alts.length) out.altTitles = alts;
    const authors = contributors(raw.authors, 'name', false);
    if (authors.length) out.authors = authors;
    const genres = genresOf(raw);
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
 * A list row's alternate titles (A30): the associated names its `metadata.series` carries, the primary left out; `null`
 * where the row carries none (the list read's series metadata has no `associated` field), never a series read.
 * @param {any} metadata
 * @param {string | null} primary
 * @returns {string[] | null}
 */
function listRowAltTitles(metadata, primary) {
    const seriesMeta = metadata && metadata.series && typeof metadata.series === 'object' ? metadata.series : null;
    if (!seriesMeta || !Array.isArray(seriesMeta.associated)) return null;
    return altTitles({ title: primary ?? seriesMeta.title, associated: seriesMeta.associated });
}

/**
 * @param {any} row - a /lists/{id}/search result: `{ record: { series, list_id, status, priority, time_added }, metadata: { series, user_rating } }`
 * @param {any} list
 */
function readingListEntry(row, list) {
    const record = row && row.record && typeof row.record === 'object' ? row.record : null;
    const series = record && record.series && typeof record.series === 'object' ? record.series : null;
    if (!series || series.id === undefined || series.id === null) return null;
    const progress = record.status && typeof record.status === 'object' ? record.status : {};
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const title = text(series.title);
    return {
        pluginEntryId: String(series.id),
        title,
        altTitles: listRowAltTitles(metadata, title),
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
     * Candidates ranked against the query, confidence 0–1, each carrying its record as far as the search row holds it
     * (A32). With `search.exactMatchPolicy` 'first', an exact match answers alone (the 3.x search's behaviour);
     * otherwise the best `search.candidateLimit`. With `allHits` (A35) every row the source answered comes back,
     * ranked, none filtered out (the client asked for at most the result cap, A36).
     * @param {MuSearchAnswer} found
     * @returns {PluginMatchCandidate[]}
     */
    search(found) {
        const withId = found.rows.filter((r) => r && r.record && r.record.series_id !== undefined && r.record.series_id !== null);
        const ranked = rankRows(found.query, withId, found.policy);
        const exact = ranked.filter((r) => r.matchType === 'exact');
        const kept = found.allHits
            ? ranked
            : (found.policy.exactMatchPolicy === 'first' && exact.length ? exact : ranked.slice(0, Math.max(1, found.policy.candidateLimit)));
        return kept.map(({ row, similarity }) => {
            /** @type {MuSearchRow} */
            const hit = row;
            const rec = hit.record || {};
            const title = text(rec.title) || text(hit.hit_title) || '';
            /** @type {PluginMatchCandidate} */
            const candidate = {
                pluginEntryId: String(rec.series_id),
                title,
                altTitles: rowTitles(hit).filter((t) => t !== title),
                confidence: Math.round(similarity * 100) / 100,
                canonicalUrl: text(rec.url),
                detail: record(hit),
            };
            return found.cached ? markCached(candidate, found.fetchedAt) : candidate;
        });
    },
    /**
     * `search.lookup` (A33): the contribution and the display part in full, from the one series read.
     * @param {MuSeries} raw
     * @returns {PluginEntryDetail}
     */
    lookup: (raw) => ({ ...contribution(raw), canonicalUrl: text(raw.url), display: display(raw) }),
    /**
     * A31: a contribution answered from the cache says so, and when it was fetched.
     * @param {{ value: any, cached: boolean, fetchedAt: string | null }} read
     */
    enrich: (read) => {
        const out = contribution(read.value);
        if (!read.cached) return { contribution: out };
        return { contribution: read.fetchedAt ? { ...out, cached: true, fetchedAt: read.fetchedAt } : { ...out, cached: true } };
    },
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
    _plainText: plainText,
};
