'use strict';

/**
 * MangaUpdates' mapping: pure, MangaUpdates' shapes in, the contract's DTOs out. Ported from the 3.x wrapper's
 * read, readinglist, search-cover and plugin-contract tests and the orphaned mapper's tests (contributor roles, year
 * fallbacks, cover metadata). The status assertions changed on purpose: the token is the list's type and the host
 * resolves it (A6, Decision 2), where the 3.x wrapper sent the host's enum from a list's position in the settings.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateResult } = require('@manga-list/plugin-sdk');
const { locateTracker } = require('../../scripts/build-runtime-plugin-package.cjs');
const { series, searchRow, listRow, membershipOf, LISTS } = require('../fixtures/mangaupdates-source.cjs');
const { searchPolicy, LIST_TYPES } = require('../../src/runtime/apiwrappers/reg-mangaupdates/client-mangaupdates.cjs');

const tracker = locateTracker();
const mapping = require(path.join(tracker.dir, `mapping-${tracker.id}.cjs`));
const values = JSON.parse(fs.readFileSync(path.join(tracker.dir, `${tracker.id}-api-settings.values.json`), 'utf8')).settings;
const policy = searchPolicy(values);

test('search: candidates carry pluginEntryId (never trackerId), a 0–1 confidence and the canonical URL', () => {
    const out = mapping.search({ query: 'Series 5', rows: [searchRow(5)], fetchedAt: null, cached: false, policy });
    assert.deepEqual(validateResult('search', out), []);
    assert.equal(out[0].pluginEntryId, '5');
    assert.equal(out[0].trackerId, undefined);
    assert.equal(out[0].confidence, 1, 'was 100 in 3.x');
    assert.equal(out[0].canonicalUrl, 'https://www.mangaupdates.com/series/5/series-5');
    assert.deepEqual(out[0].altTitles, ['The Series 5', 'シリーズ 5']);
});

test('search: an associated title equal to the query is an exact match (the 3.x alias search)', () => {
    const out = mapping.search({ query: 'The Series 7', rows: [searchRow(7)], fetchedAt: null, cached: false, policy });
    assert.equal(out[0].confidence, 1);
});

test('search: no exact match gives the ranked candidates, best first, at most search.candidateLimit, rows without an id dropped', () => {
    const rows = [searchRow(1), searchRow(2), searchRow(3), searchRow(4), searchRow(5), searchRow(6), { hit_title: 'no record' }];
    const out = mapping.search({ query: 'Series', rows, fetchedAt: null, cached: false, policy });
    assert.equal(out.length, policy.candidateLimit);
    assert.ok(out.every((/** @type {any} */ c) => c.confidence === 0.85), 'containment');
    const rowOf = (/** @type {number} */ id, /** @type {string} */ title) => ({ record: { series_id: id, title }, hit_title: title });
    const ranked = mapping.search({ query: 'Alpha Beta Gamma Zeta', rows: [rowOf(21, 'Alpha Beta Delta Epsilon'), rowOf(20, 'Alpha Beta Gamma')], fetchedAt: null, cached: false, policy });
    assert.deepEqual(ranked.map((/** @type {any} */ c) => [c.pluginEntryId, c.confidence]), [['20', 0.85], ['21', 0.33]], 'the closer title ranks first, whatever the site\'s order');
});

test('search: a cached answer says so, with its fetch time when it has one', () => {
    const withTime = mapping.search({ query: 'Series 1', rows: [searchRow(1)], fetchedAt: '2026-01-01T00:00:00Z', cached: true, policy });
    assert.equal(withTime[0].cached, true);
    assert.equal(withTime[0].fetchedAt, '2026-01-01T00:00:00Z');
    const noTime = mapping.search({ query: 'Series 1', rows: [searchRow(1)], fetchedAt: null, cached: true, policy });
    assert.equal(noTime[0].cached, true);
    assert.equal(noTime[0].fetchedAt, undefined);
});

test('lookup and enrich: the contribution — titles, contributors with roles, genres, cover, year, type, its source link', () => {
    const detail = mapping.lookup(series(2));
    assert.deepEqual(validateResult('lookup', detail), []);
    assert.equal(detail.pluginEntryId, '2');
    assert.equal(detail.canonicalUrl, 'https://www.mangaupdates.com/series/2/series-2');
    assert.equal(detail.displayTitle, 'Series 2');
    assert.deepEqual(detail.altTitles, ['The Series 2', 'シリーズ 2']);
    assert.deepEqual(detail.authors, [{ name: 'An Author', type: 'Author' }, { name: 'An Artist', type: 'Artist' }]);
    assert.deepEqual(detail.publishers, [{ name: 'A Publisher', type: 'Original' }]);
    assert.deepEqual(detail.genres, ['Action', 'Drama']);
    assert.equal(detail.coverUrl, 'https://cdn.mangaupdates.com/image/i2.jpg');
    assert.equal(detail.year, 2020, 'the year comes as a string');
    assert.equal(detail.seriesType, 'Manga');
    assert.equal(detail.seriesStatus, 'ongoing');
    assert.deepEqual(detail.sourceLinks, [{ siteId: 'mangaupdates', siteLabel: 'MangaUpdates', seriesUrl: 'https://www.mangaupdates.com/series/2/series-2', isPrimary: true }]);
    assert.equal(mapping.enrich({ value: series(2), cached: false, fetchedAt: null }).contribution.pluginEntryId, '2');
    assert.equal('canonicalUrl' in mapping.enrich({ value: series(2), cached: false, fetchedAt: null }).contribution, false);
    // A31: a cached read says so, and when it was fetched; one cached before the time was kept says it was cached alone.
    const cached = mapping.enrich({ value: series(2), cached: true, fetchedAt: '2026-11-15T00:00:00.000Z' }).contribution;
    assert.deepEqual([cached.cached, cached.fetchedAt], [true, '2026-11-15T00:00:00.000Z']);
    const old = mapping.enrich({ value: series(2), cached: true, fetchedAt: null }).contribution;
    assert.deepEqual([old.cached, 'fetchedAt' in old], [true, false]);
});

test('contribution: series status from the status text or the completed flag', () => {
    assert.equal(mapping._seriesStatus({ status: '10 Volumes (Complete)' }), 'completed');
    assert.equal(mapping._seriesStatus({ status: '3 Volumes (On Hiatus)' }), 'hiatus');
    assert.equal(mapping._seriesStatus({ status: 'Publishing' }), 'ongoing');
    assert.equal(mapping._seriesStatus({ status: '', completed: true }), 'completed');
    assert.equal(mapping._seriesStatus({}), 'unknown');
});

test('contribution: a publisher\'s "Publisher" role is the original publisher; a name appears once; year falls back to year_released', () => {
    assert.deepEqual(mapping._contributors([{ publisher_name: 'Naver', type: 'Publisher' }, { publisher_name: 'naver', type: 'English' }, { publisher_name: 'Line Webtoon', role: 'publisher' }], 'publisher_name', true), [
        { name: 'Naver', type: 'Original' },
        { name: 'Line Webtoon', type: 'Original' },
    ]);
    assert.equal(mapping.lookup({ ...series(9), year: '', year_released: '2019' }).year, 2019);
    assert.equal(mapping.lookup({ ...series(9), url: undefined }).canonicalUrl, null, 'no URL is null, never a guessed one');
});

test('getReadingList: the list\'s type is the token and its id is listId; a custom list answers its own type and id (A2)', () => {
    const out = mapping.getReadingList([
        { list: LISTS[0], rows: [listRow(1), listRow(2)] },
        { list: LISTS[2], rows: [listRow(4)] },
        { list: LISTS[5], rows: [listRow(5)] },
    ]);
    assert.deepEqual(validateResult('getReadingList', out, { manifest: tracker.manifest }), []);
    assert.deepEqual(out.map((/** @type {any} */ e) => [e.pluginEntryId, e.status, e.listId]), [['1', 'read', 0], ['2', 'read', 0], ['4', 'complete', 2], ['5', 'read', 101]]);
    assert.deepEqual(out[0], {
        pluginEntryId: '1', title: 'Series 1', altTitles: null, canonicalUrl: 'https://www.mangaupdates.com/series/1/series-1', status: 'read',
        chapter: 12, rating: 8.5, volume: 2, listId: 0, priority: 0, lastUpdated: new Date(1700000000 * 1000).toISOString(),
    });
});

test('getReadingList: altTitles (A30) are the associated names the row\'s series metadata carries, the primary left out; null where it carries none', () => {
    const row = listRow(1);
    row.metadata.series.associated = [{ title: 'Series 1' }, { title: 'The Series 1' }, { title: 'シリーズ 1' }, { title: 'The Series 1' }];
    const out = mapping.getReadingList([{ list: LISTS[0], rows: [row, listRow(2)] }]);
    assert.deepEqual(validateResult('getReadingList', out, { manifest: tracker.manifest }), []);
    assert.deepEqual(out[0].altTitles, ['The Series 1', 'シリーズ 1']);
    assert.equal(out[1].altTitles, null, 'the list read\'s series metadata has no associated names: null, never a series read');
    const empty = listRow(3);
    empty.metadata.series.associated = [];
    assert.deepEqual(mapping.getReadingList([{ list: LISTS[0], rows: [empty] }])[0].altTitles, []);
});

test('getReadingList: a row without a series id is skipped; a list of a type MangaUpdates does not define has a null token', () => {
    const out = mapping.getReadingList([{ list: { list_id: 7, type: 'something-new' }, rows: [listRow(1), { record: { series: {} } }, { metadata: {} }] }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, null);
    assert.equal(out[0].listId, 7);
});

test('pullProgress: the list type, chapter, rating and time added; on no list all-null', () => {
    assert.deepEqual(mapping.pullProgress({ entry: membershipOf(4), list: LISTS[2], rating: 9 }, '4'), {
        pluginEntryId: '4', status: 'complete', chapter: 100, rating: 9, lastUpdated: new Date(1700000300 * 1000).toISOString(),
    });
    assert.deepEqual(mapping.pullProgress({ entry: null, list: null, rating: null }, '9'), { pluginEntryId: '9', status: null, chapter: null, rating: null, lastUpdated: null });
    assert.deepEqual(validateResult('pullProgress', mapping.pullProgress({ entry: membershipOf(1), list: LISTS[0], rating: 8.5 }, '1'), { manifest: tracker.manifest }), []);
});

test('pushProgress and subscribe: what landed', () => {
    assert.deepEqual(mapping.pushProgress({ chapter: 45, volume: 3, rating: 8.5 }), { applied: { chapter: 45, rating: 8.5 } });
    assert.deepEqual(mapping.pushProgress({}), { applied: {} });
    assert.deepEqual(mapping.subscribe({ list: LISTS[5] }), { listId: 101, status: 'read' });
});

test('searchCovers: the series\' one cover with its thumbnail and size; none without a URL', () => {
    assert.deepEqual(mapping.searchCovers(series(3)), [{ coverId: '3', imageUrl: 'https://cdn.mangaupdates.com/image/i3.jpg', thumbnailUrl: 'https://cdn.mangaupdates.com/image/thumb/i3.jpg', width: 400, height: 600 }]);
    assert.deepEqual(mapping.searchCovers({ ...series(3), image: { url: { original: 'image/i3.png' } } })[0].imageUrl, 'https://cdn.mangaupdates.com/image/i3.png', 'a relative CDN path is completed');
    assert.deepEqual(mapping.searchCovers({ ...series(3), image: null }), []);
});

test('queryLive: the ok arm, no linkState (A4)', () => {
    const out = mapping.queryLive(series(1), '1');
    assert.deepEqual(validateResult('queryLive', out), []);
    assert.equal(out.data.statusLabel, '5 Volumes (Ongoing)');
    assert.deepEqual(out.data.sections[1], { type: 'link-list', label: 'Links', links: [{ label: 'MangaUpdates', url: 'https://www.mangaupdates.com/series/1/series-1' }] });
});

test('summarizeEntries: the series\' volatile state — status text, its state word, latest chapter, last update — never a link state', () => {
    const out = mapping.summarizeEntries(series(1));
    assert.deepEqual(out.summary, { label: '5 Volumes (Ongoing)', status: 'ongoing', latestChapter: 42, lastUpdated: new Date(1759276800 * 1000).toISOString() });
    assert.equal(mapping.summarizeEntries({ ...series(1), status: '', completed: true }).summary.status, 'complete');
    assert.deepEqual(mapping.summarizeEntries({ series_id: 2 }).summary, { label: null, status: null, latestChapter: null, lastUpdated: null });
});

test('the manifest\'s two tables: every list type is a pull key, every non-null push target resolves back (A2); RE_READING has no list type', () => {
    const { push, pull } = tracker.manifest.syncOptions.statusVocabulary;
    assert.deepEqual(Object.keys(pull).sort(), [...LIST_TYPES].sort());
    for (const [status, token] of Object.entries(push)) {
        if (token !== null) assert.equal(pull[/** @type {string} */ (token)], status, `${status} → ${token} → ${status}`);
    }
    assert.equal(push.RE_READING, null);
    assert.equal(push.DROPPED, 'unfinished', "the 3.x manifest's 'dropped' was not a MangaUpdates token");
    assert.equal(push.READING, 'read', "the 3.x manifest's 'reading' was not a MangaUpdates token");
});

test('the statusMapping override is the custom-list list_id, empty by default (Decision 2)', () => {
    for (const status of Object.keys(tracker.manifest.syncOptions.statusVocabulary.push)) {
        assert.equal(values[`statusMapping.${status}`], null, status);
    }
});

// ── contract 4.4.0: the record, the display part, cancelled, every hit (A32–A35) ───────────────────────────────

const { NOVEL_ID, CANCELLED_ID, SYSTEM_USER_LIST } = require('../fixtures/mangaupdates-source.cjs');

test('search (A32): each candidate carries its record as far as the search row holds it, without its identity', () => {
    const out = mapping.search({ query: 'Series 1', rows: [searchRow(1, 'The Series 1 Matched')], fetchedAt: null, cached: false, policy, allHits: false });
    assert.deepEqual(validateResult('search', out), []);
    const detail = out[0].detail;
    for (const key of ['pluginEntryId', 'canonicalUrl', 'syncedAt', 'cached', 'fetchedAt']) assert.equal(key in detail, false, `${key} is the candidate's`);
    assert.equal(detail.displayTitle, 'Series 1');
    assert.equal(detail.description, 'A series.');
    assert.equal(detail.seriesType, 'Manga');
    assert.equal(detail.year, 2020);
    assert.deepEqual(detail.genres, ['Action', 'Drama']);
    assert.equal('seriesStatus' in detail, false, 'the search row holds no status: absent, never unknown');
    assert.deepEqual(detail.display.ratings, [{ source: 'MangaUpdates', value: 7.5, scale: 10, votes: 651 }]);
    assert.deepEqual(detail.display.dates, { updated: '2025-10-01T00:00:00.000Z' });
    assert.deepEqual(detail.display.cover.sizes.map((/** @type {{ url: string }} */ s) => s.url), ['https://cdn.mangaupdates.com/image/i1.jpg', 'https://cdn.mangaupdates.com/image/thumb/i1.jpg']);
    assert.deepEqual(detail.display.titles[0], { title: 'Series 1', kind: 'main' });
    assert.ok(detail.display.titles.some((/** @type {{ title: string, kind: string }} */ t) => t.title === 'The Series 1 Matched' && t.kind === 'alternate'), "the matched title is one of its titles; that it matched is the host's mark");
    for (const key of ['statusText', 'tags', 'popularity', 'licensing', 'relations', 'recommendations', 'magazine']) {
        assert.equal(key in detail.display, false, `${key}: the series read's, not the search row's`);
    }
});

test("search (card brief §5 rule 11): the searching account's own list entry (metadata.user_list) is never in a candidate", () => {
    const row = searchRow(1);
    assert.deepEqual(row.metadata.user_list, SYSTEM_USER_LIST, "the fixture row carries the system account's entry");
    const [candidate] = mapping.search({ query: 'Series 1', rows: [row], fetchedAt: null, cached: false, policy, allHits: true });
    const json = JSON.stringify(candidate);
    assert.equal(json.includes('user_list'), false);
    assert.equal(json.includes('list_id'), false);
    assert.equal(json.includes('"chapter"'), false);
});

test('search (A35): with allHits every row comes back ranked, the exact-match rule and candidateLimit skipped; without it, as before', () => {
    const rows = [searchRow(1), searchRow(12), searchRow(NOVEL_ID), ...[2, 3, 4, 5, 6, 7].map((id) => searchRow(id))];
    const filtered = mapping.search({ query: 'Series 1', rows, fetchedAt: null, cached: false, policy, allHits: false });
    assert.deepEqual(filtered.map((/** @type {{ pluginEntryId: string }} */ c) => c.pluginEntryId), ['1'], 'an exact match answers alone (exactMatchPolicy first)');
    const every = mapping.search({ query: 'Series 1', rows, fetchedAt: null, cached: false, policy, allHits: true });
    assert.equal(every.length, rows.length);
    assert.equal(every[0].pluginEntryId, '1');
    assert.ok(every.some((/** @type {{ pluginEntryId: string }} */ c) => c.pluginEntryId === String(NOVEL_ID)));
    assert.deepEqual(validateResult('search', every), []);
});

test('lookup (A33): the display part in full from the one series read', () => {
    const detail = mapping.lookup(series(2));
    assert.deepEqual(validateResult('lookup', detail), []);
    const d = detail.display;
    assert.deepEqual(d.titles, [{ title: 'Series 2', kind: 'main' }, { title: 'The Series 2', kind: 'alternate' }, { title: 'シリーズ 2', kind: 'alternate' }]);
    assert.deepEqual(d.descriptions, [{ text: 'A series.' }]);
    assert.deepEqual(d.cover, { sizes: [{ url: 'https://cdn.mangaupdates.com/image/i2.jpg', width: 400 }, { url: 'https://cdn.mangaupdates.com/image/thumb/i2.jpg' }] });
    assert.equal(d.statusText, '5 Volumes (Ongoing)');
    assert.deepEqual(d.chapters, { latest: 42 });
    assert.equal(d.magazine, 'A Weekly Magazine');
    assert.deepEqual(d.tags, [{ name: 'Adapted to Anime', votes: 5 }, { name: 'Elf', votes: 3 }]);
    assert.deepEqual(d.ratings, [{ source: 'MangaUpdates', value: 7.5, scale: 10, votes: 651 }]);
    assert.deepEqual(d.popularity, { rank: 26, lists: 3841 + 920 + 44 + 83 + 477 });
    assert.deepEqual(d.licensing, { licensed: true, anime: true });
    assert.deepEqual(d.relations, [{ relation: 'Spin-Off', title: 'Series 77', pluginEntryId: '77', url: 'https://www.mangaupdates.com/series/25/series-77' }]);
    assert.deepEqual(d.recommendations.map((/** @type {{ pluginEntryId: string }} */ r) => r.pluginEntryId), ['78', '79'], "the users' and the category-based, a series once");
    assert.deepEqual(detail.authors, [{ name: 'An Author', type: 'Author' }, { name: 'An Artist', type: 'Artist' }], "the role is the contributor's own type");
    assert.equal(detail.seriesStatus, 'ongoing');
});

test('lookup (A34, A32): a cancelled series is cancelled, its status text kept line by line; what it does not hold is absent', () => {
    const detail = mapping.lookup(series(CANCELLED_ID));
    assert.deepEqual(validateResult('lookup', detail), []);
    assert.equal(detail.seriesStatus, 'cancelled');
    assert.equal(detail.display.statusText, '12 Chapters (Cancelled)\nS1: 8 Chapters (1-8)\nS2: 4 Chapters (9-12');
    assert.deepEqual(detail.display.descriptions, [{ text: 'From a publisher: a series.\n\nIn two parts & more.' }], 'plain text, line breaks kept');
    assert.deepEqual(detail.display.licensing, { licensed: false }, 'an empty anime range says nothing');
    for (const key of ['ratings', 'popularity', 'tags', 'relations', 'recommendations', 'magazine']) {
        assert.equal(key in detail.display, false, `${key}: not held, so absent`);
    }
});

test("contribution (A34): cancelled from the status text; the first line is the series' own, the lines after it its parts", () => {
    assert.equal(mapping._seriesStatus({ status: '12 Chapters (Cancelled)' }), 'cancelled');
    assert.equal(mapping._seriesStatus({ status: '3 Volumes (Discontinued)' }), 'cancelled');
    assert.equal(mapping._seriesStatus({ status: '570 Chapters (Complete)\nS1: 41 Chapters (1-41)' }), 'completed');
    assert.equal(mapping._seriesStatus({ status: '12 Chapters (Ongoing)<BR>S1: 12 Chapters (Complete)' }), 'ongoing');
    assert.equal(mapping._seriesStatus({ status: '12 Chapters\nS1: 12 Chapters (Hiatus)' }), 'hiatus', 'a first line with no state falls back to the whole text');
    assert.equal(mapping._plainText('a<br>b<BR/>c &amp; d &#39;e&#39;'), "a\nb\nc & d 'e'");
});
