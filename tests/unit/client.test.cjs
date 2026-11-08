'use strict';

/**
 * MangaUpdates' client, through the plugin the SDK builds, against the fixture source: the source calls, their
 * fields and their failures. Ported from the 3.x wrapper's read, readinglist, write, token, search-cover,
 * search-freshness, querylive and init tests; their live-confirmed facts are kept (the site's real remove call,
 * a list write clearing the cached list, the integer chapter, rating 0 as "cleared", the rating endpoint's 404),
 * what the SDK now owns (the token cache, the 401 replay, retries, per-entry arrays) is tested in the SDK.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createStubAxios, createStubContext, callContext } = require('@manga-list/plugin-sdk/testing');
const { isPluginError } = require('@manga-list/plugin-sdk');
const { locateTracker } = require('../../scripts/build-runtime-plugin-package.cjs');
const { createSource, BASE } = require('../fixtures/mangaupdates-source.cjs');
const { htmlNormalizer } = require('../../src/runtime/apiwrappers/reg-mangaupdates/client-mangaupdates.cjs');

const tracker = locateTracker();
const descriptor = require(path.join(tracker.dir, `plugin-${tracker.id}.cjs`));
const values = JSON.parse(fs.readFileSync(path.join(tracker.dir, `${tracker.id}-api-settings.values.json`), 'utf8')).settings;

const ALPHA = { username: 'mu-alpha', password: 'alpha-pass' };
const user = (overrides = {}) => callContext({ credential: ALPHA, identity: 'slot-a', scope: 'user-a', ...overrides });
const system = () => callContext({ credential: ALPHA, identity: 'system-slot', scope: 'system' });

/**
 * @param {{ wrap?: (handler: (config: Record<string, any>) => any) => (config: Record<string, any>) => any, settings?: Record<string, unknown> }} [options]
 */
async function plugin(options = {}) {
    const source = createSource();
    /** @type {Record<string, unknown>} */
    const settings = { ...values, 'retry.backoff.initialDelay': 1, 'retry.maxAttempts': 2, 'rateLimit.perEndpoint.defaultDelay': 0, 'rateLimit.global.maxPerSecond': 0, ...(options.settings || {}) };
    for (const key of Object.keys(settings)) if (key.endsWith('.throttle')) settings[key] = 0;
    const axios = createStubAxios(options.wrap ? options.wrap(source.handler) : source.handler);
    const instance = await descriptor.WrapperClass.init({ context: createStubContext({ axios }), serviceSettings: settings });
    /** @param {string} method @param {string} suffix */
    const callsTo = (method, suffix) => axios.calls.filter((c) => String(c.method).toLowerCase() === method && String(c.url).split('?')[0].endsWith(suffix));
    return { instance, axios, source, callsTo };
}

// ── the session ─────────────────────────────────────────────────────────────

test('session login: PUT /account/login with the username and password, the session token sent as Bearer, one login per identity', async () => {
    const { instance, axios, source } = await plugin();
    await instance.getReadingList(user());
    await instance.pullProgress('1', user());
    const login = axios.calls.filter((c) => String(c.url).endsWith('/account/login'));
    assert.equal(login.length, 1);
    assert.equal(login[0].method, 'put');
    assert.deepEqual(login[0].data, ALPHA);
    assert.ok(axios.calls.filter((c) => String(c.url).includes('/lists')).every((c) => c.headers.Authorization === 'Bearer session-mu-alpha-1'));
    await instance.getReadingList(user({ identity: 'slot-b', scope: 'user-b', credential: { username: 'mu-beta', password: 'beta-pass' } }));
    assert.deepEqual(source.logins, ['mu-alpha', 'mu-beta'], 'another identity logs in on its own');
});

test('session re-login on 401: a session the site killed early is replaced once and the request replayed once', async () => {
    const { instance, source, callsTo } = await plugin();
    await instance.pullProgress('2', user());
    source.revoke();
    const out = await instance.pullProgress('1', user());
    assert.equal(out.status, 'read', 'the replayed request answered');
    assert.deepEqual(source.logins, ['mu-alpha', 'mu-alpha']);
    const reads = callsTo('get', '/lists/series/1');
    assert.deepEqual(reads.map((c) => c.headers.Authorization), ['Bearer session-mu-alpha-1', 'Bearer session-mu-alpha-2']);
});

test('session re-login on 401: a second 401 is the call\'s failure, never a loop', async () => {
    const { instance, source } = await plugin({ wrap: (handler) => (config) => (String(config.url).includes('/lists/series/') ? { status: 401 } : handler(config)) });
    await assert.rejects(instance.pullProgress('1', user()), (e) => isPluginError(e) && e.code === 'credential_rejected');
    assert.equal(source.logins.length, 2, 'one login, one re-login, no more');
});

test('testCredentials: true for a good login, false for a refused one, false with nothing to send; no other call made', async () => {
    const { instance, axios } = await plugin();
    assert.equal(await instance.testCredentials(ALPHA), true);
    assert.equal(await instance.testCredentials({ username: 'mu-alpha', password: 'wrong' }), false);
    assert.equal(await instance.testCredentials({}), false);
    assert.ok(axios.calls.every((c) => String(c.url).endsWith('/account/login')));
});

test('testCredentials: a login answer with no session is a refusal', async () => {
    const { instance } = await plugin({ wrap: (handler) => (config) => (String(config.url).endsWith('/account/login') ? { status: 200, data: { status: 'exception', reason: 'Account locked.' } } : handler(config)) });
    assert.equal(await instance.testCredentials(ALPHA), false);
});

// ── lists ───────────────────────────────────────────────────────────────────

test('getReadingList: every list, the custom one too, each read whole page by page; the token is the list type, listId the list', async () => {
    const { instance, callsTo } = await plugin();
    const list = await instance.getReadingList(user());
    assert.deepEqual(list.map((/** @type {any} */ e) => [e.pluginEntryId, e.status, e.listId]), [
        ['1', 'read', 0], ['2', 'read', 0], ['3', 'read', 0], ['4', 'complete', 2], ['5', 'read', 101],
    ]);
    assert.deepEqual(callsTo('post', '/lists/0/search').map((c) => c.data.page), [1, 2], 'the three-entry list is two pages (total_hits)');
    assert.equal(callsTo('post', '/lists/0/search')[0].data.perpage, values['api.endpoints.listSearch.perPage']);
    assert.equal(list[0].rating, 8.5, 'the rating rides on the list read (metadata.user_rating, live 2026-07-23)');
    assert.equal(list[0].chapter, 12);
    assert.equal(list[0].canonicalUrl, 'https://www.mangaupdates.com/series/1/series-1');
    assert.equal(list[0].lastUpdated, new Date(1700000000 * 1000).toISOString());
    assert.equal('comparison' in list[0], false, 'A13: the host compares');
});

test('getReadingList: without a total_hits, a short page ends the list', async () => {
    const { instance, callsTo } = await plugin({
        settings: { 'api.endpoints.listSearch.perPage': 2 },
        wrap: (handler) => (config) => {
            const out = handler(config);
            if (/\/lists\/\d+\/search$/.test(String(config.url))) delete out.data.total_hits;
            return out;
        },
    });
    const list = await instance.getReadingList(user());
    assert.equal(list.length, 5);
    assert.deepEqual(callsTo('post', '/lists/0/search').map((c) => c.data.page), [1, 2]);
});

test('the lists and their contents are cached per scope, never shared with another user', async () => {
    const { instance, callsTo } = await plugin();
    await instance.getReadingList(user());
    await instance.getReadingList(user());
    assert.equal(callsTo('get', '/lists').length, 1);
    assert.equal(callsTo('post', '/lists/2/search').length, 1);
    await instance.getReadingList(user({ scope: 'user-b' }));
    assert.equal(callsTo('get', '/lists').length, 2, 'another scope reads its own');
});

test('a list write clears the cached list it changed: subscribe moving a series re-reads both lists, and only those', async () => {
    const { instance, callsTo } = await plugin();
    await instance.getReadingList(user());
    await instance.subscribe([{ pluginEntryId: '1', status: '101' }], user());
    await instance.getReadingList(user());
    assert.equal(callsTo('post', '/lists/101/search').length, 2, 'the list it joined');
    assert.equal(callsTo('post', '/lists/0/search').length, 4, 'the list it left (two pages, twice)');
    assert.equal(callsTo('post', '/lists/2/search').length, 1, 'an untouched list stays cached');
    assert.equal(callsTo('get', '/lists').length, 1, 'the list-of-lists is not changed by a series write');
});

test('a list write clears the cached list it changed: unsubscribe and a progress push too', async () => {
    const { instance, callsTo } = await plugin();
    await instance.getReadingList(user());
    await instance.unsubscribe(['4'], user());
    await instance.pushProgress([{ pluginEntryId: '5', chapter: 8 }], user());
    await instance.getReadingList(user());
    assert.equal(callsTo('post', '/lists/2/search').length, 2);
    assert.equal(callsTo('post', '/lists/101/search').length, 2);
    assert.equal(callsTo('post', '/lists/1/search').length, 1);
});

// ── subscribe ───────────────────────────────────────────────────────────────

test('subscribe by type token: a series on no list is added to the account\'s list of that type', async () => {
    const { instance, callsTo } = await plugin();
    const out = await instance.subscribe([{ pluginEntryId: '6', status: 'wish' }], user());
    assert.deepEqual(out, [{ pluginEntryId: '6', success: true, listId: 1, status: 'wish' }]);
    assert.deepEqual(callsTo('post', '/lists/series')[0].data, [{ series: { id: 6 }, list_id: 1 }]);
    assert.equal(callsTo('post', '/lists/series/update').length, 0);
});

test('subscribe by type token: the typed list is chosen over a custom list of the same type', async () => {
    const { instance, callsTo } = await plugin();
    const out = await instance.subscribe([{ pluginEntryId: '4', status: 'read' }], user());
    assert.deepEqual(out[0], { pluginEntryId: '4', success: true, listId: 0, status: 'read' });
    assert.deepEqual(callsTo('post', '/lists/series/update')[0].data, [{ series: { id: 4 }, list_id: 0 }], 'already on a list: moved, not added twice');
});

test('subscribe by a custom list id (the host\'s statusMapping override): the series goes to that list, its type the token', async () => {
    const { instance, callsTo } = await plugin();
    const out = await instance.subscribe([{ pluginEntryId: '2', status: '101' }], user());
    assert.deepEqual(out[0], { pluginEntryId: '2', success: true, listId: 101, status: 'read' });
    assert.deepEqual(callsTo('post', '/lists/series/update')[0].data, [{ series: { id: 2 }, list_id: 101 }]);
});

test('subscribe: a list id the account does not have, or a token MangaUpdates does not define, fails that entry alone', async () => {
    const { instance, callsTo } = await plugin();
    const out = await instance.subscribe([{ pluginEntryId: '6', status: '999' }, { pluginEntryId: '7', status: 'reading' }, { pluginEntryId: '8', status: 'hold' }], user());
    assert.equal(out[0].success, false);
    assert.equal(out[0].error.code, 'not_found');
    assert.equal(out[1].success, false, "'reading' is the 3.x manifest's wrong token, not a list type");
    assert.deepEqual(out[2], { pluginEntryId: '8', success: true, listId: 4, status: 'hold' });
    assert.equal(callsTo('get', '/lists').length, 2, 'an unknown list id asks for the lists once more before failing');
});

test('subscribe: the host\'s own status is refused before any call (A6)', async () => {
    const { instance, axios } = await plugin();
    await assert.rejects(instance.subscribe([{ pluginEntryId: '6', status: 'READING' }], user()), (e) => isPluginError(e) && e.code === 'host_contract_violation');
    assert.equal(axios.calls.length, 0);
});

test('subscribe: an "exception" answer from the site is that entry\'s failure', async () => {
    const { instance } = await plugin({ wrap: (handler) => (config) => (String(config.url).endsWith('/lists/series') ? { status: 200, data: { status: 'exception', reason: 'Series is locked.' } } : handler(config)) });
    const out = await instance.subscribe([{ pluginEntryId: '6', status: 'read' }], user());
    assert.equal(out[0].success, false);
    assert.equal(out[0].error.code, 'source_error');
    assert.match(out[0].error.message, /Series is locked/);
});

// ── unsubscribe ─────────────────────────────────────────────────────────────

test('unsubscribe: the site\'s real call, the series id posted to /lists/series/delete (live 2026-11-07), never a DELETE', async () => {
    const { instance, axios, callsTo } = await plugin();
    assert.deepEqual(await instance.unsubscribe(['3'], user()), [{ pluginEntryId: '3', success: true }]);
    assert.deepEqual(callsTo('post', '/lists/series/delete')[0].data, [3]);
    assert.equal(axios.calls.some((c) => c.method === 'delete'), false);
});

test('unsubscribe: a series on no list is success with no remove call (idempotent)', async () => {
    const { instance, callsTo } = await plugin();
    assert.deepEqual(await instance.unsubscribe(['77'], user()), [{ pluginEntryId: '77', success: true }]);
    assert.equal(callsTo('post', '/lists/series/delete').length, 0);
});

test('unsubscribe: an "exception" reply is a refusal whatever its case; one entry failing does not fail the batch', async () => {
    const { instance } = await plugin({
        wrap: (handler) => (config) => (String(config.url).endsWith('/lists/series/delete') && config.data[0] === 1
            ? { status: 200, data: { status: 'Exception', reason: 'Nope.' } }
            : handler(config)),
    });
    const out = await instance.unsubscribe(['1', '2'], user());
    assert.equal(out[0].success, false);
    assert.equal(out[0].error.code, 'source_error');
    assert.equal(out[1].success, true);
});

// ── progress ────────────────────────────────────────────────────────────────

test('pullProgress: the list type as the token, chapter, the rating from its own endpoint, time added', async () => {
    const { instance, callsTo } = await plugin();
    assert.deepEqual(await instance.pullProgress('4', user()), { pluginEntryId: '4', status: 'complete', chapter: 100, rating: 9, lastUpdated: new Date(1700000300 * 1000).toISOString() });
    assert.equal(callsTo('get', '/series/4/rating').length, 1);
    assert.equal(callsTo('get', '/lists/series/4')[0].url, `${BASE}/lists/series/4?unrenderedFields=true`);
});

test('pullProgress: a series on a custom list answers that list\'s type', async () => {
    const { instance } = await plugin();
    assert.equal((await instance.pullProgress('5', user())).status, 'read');
});

test('pullProgress: a series on no list (404) is all-null, never a throw; an unrated series (rating 404) has rating null', async () => {
    const { instance } = await plugin();
    assert.deepEqual(await instance.pullProgress('77', user()), { pluginEntryId: '77', status: null, chapter: null, rating: null, lastUpdated: null });
    assert.equal((await instance.pullProgress('2', user())).rating, null);
});

test('pullProgress: a failed rating read does not fail the pull of the primary fields', async () => {
    const { instance } = await plugin({ wrap: (handler) => (config) => (String(config.url).endsWith('/rating') ? { status: 500 } : handler(config)) });
    const out = await instance.pullProgress('1', user());
    assert.equal(out.chapter, 12);
    assert.equal(out.rating, null);
});

test('pushProgress: chapter and volume to the series\' current list as positive integers, the rating PUT; never a list change', async () => {
    const { instance, callsTo } = await plugin();
    const out = await instance.pushProgress([{ pluginEntryId: '4', chapter: 45.5, volume: 3, rating: 8.5 }], user());
    assert.deepEqual(callsTo('post', '/lists/series/update')[0].data, [{ series: { id: 4 }, list_id: 2, status: { chapter: 45, volume: 3 } }]);
    assert.deepEqual(callsTo('put', '/series/4/rating')[0].data, { rating: 8.5 });
    assert.deepEqual(out, [{ pluginEntryId: '4', success: true, applied: { chapter: 45, rating: 8.5 } }]);
});

test('pushProgress: rating 0 clears the rating with a DELETE (the host\'s 0 is "no rating"), and an already-cleared one is fine', async () => {
    const { instance, callsTo } = await plugin({ wrap: (handler) => (config) => (config.method === 'delete' && String(config.url).endsWith('/2/rating') ? { status: 404 } : handler(config)) });
    const out = await instance.pushProgress([{ pluginEntryId: '1', rating: 0 }, { pluginEntryId: '2', rating: 0 }], user());
    assert.equal(callsTo('delete', '/series/1/rating').length, 1);
    assert.equal(callsTo('put', '/series/1/rating').length, 0);
    assert.deepEqual(out.map((/** @type {any} */ r) => r.success), [true, true]);
    assert.equal(callsTo('post', '/lists/series/update').length, 0, 'no chapter, no list write');
});

test('pushProgress: a series on no list is not_found (subscribe first); one entry failing does not fail the batch', async () => {
    const { instance } = await plugin();
    const out = await instance.pushProgress([{ pluginEntryId: '77', chapter: 1 }, { pluginEntryId: '1', chapter: 13 }], user());
    assert.equal(out[0].success, false);
    assert.equal(out[0].error.code, 'not_found');
    assert.equal(out[1].success, true);
});

// ── search, covers, series ──────────────────────────────────────────────────

test('search: an exact title answers alone; a repeat is answered from the cache with its fetch time; refresh asks again', async () => {
    const { instance, callsTo } = await plugin();
    const live = await instance.search('Series 1', undefined, system());
    assert.deepEqual(live.map((/** @type {any} */ c) => [c.pluginEntryId, c.confidence]), [['1', 1]]);
    assert.equal(live[0].cached, undefined);
    assert.equal(callsTo('post', '/series/search')[0].data.search, 'Series 1');
    assert.equal(callsTo('post', '/series/search')[0].headers.Authorization, 'Bearer session-mu-alpha-1', 'search is authenticated (searchOptions.requiresCredential)');
    const cached = await instance.search('Series 1', undefined, system());
    assert.equal(cached[0].cached, true);
    assert.equal(typeof cached[0].fetchedAt, 'string');
    assert.equal(callsTo('post', '/series/search').length, 1);
    const refreshed = await instance.search('Series 1', { refresh: true }, system());
    assert.equal(refreshed[0].cached, undefined);
    assert.equal(callsTo('post', '/series/search').length, 2);
});

test('search: with exactMatchPolicy highestScore every ranked candidate comes back, best first, confidence 0–1', async () => {
    const { instance } = await plugin({ settings: { 'search.exactMatchPolicy': 'highestScore' } });
    const out = await instance.search('Series 1', undefined, system());
    assert.deepEqual(out.map((/** @type {any} */ c) => [c.pluginEntryId, c.confidence]), [['1', 1], ['12', 0.85]]);
});

test('search: a blank query asks nothing', async () => {
    const { instance, axios } = await plugin();
    assert.deepEqual(await instance.search('   ', undefined, system()), []);
    assert.equal(axios.calls.length, 0);
});

test('lookup: full detail with the canonical URL (search.lookup, F12); a series MangaUpdates does not have is not_found', async () => {
    const { instance } = await plugin();
    const detail = await instance.lookup('3', system());
    assert.equal(detail.pluginEntryId, '3');
    assert.equal(detail.canonicalUrl, 'https://www.mangaupdates.com/series/3/series-3');
    await assert.rejects(instance.lookup('901', system()), (e) => isPluginError(e) && e.code === 'not_found');
});

test('searchCovers: id mode fetches the known series; title mode takes the exact or fuzzy match; no match is no cover', async () => {
    const { instance, callsTo } = await plugin();
    const byId = await instance.searchCovers({ title: 'ignored' }, { pluginEntryId: '3' }, system());
    assert.equal(byId[0].coverId, '3');
    assert.equal(byId[0].imageUrl, 'https://cdn.mangaupdates.com/image/i3.jpg');
    assert.equal(callsTo('post', '/series/search').length, 0, 'id mode skips the search');
    const byTitle = await instance.searchCovers({ title: 'Series 1' }, undefined, system());
    assert.equal(byTitle[0].coverId, '1');
    assert.deepEqual(await instance.searchCovers({ title: 'Nothing like it' }, undefined, system()), []);
});

test('downloadCover: bytes from the series\' CDN URL, cached; the 3.x "<id>/<file>" form is accepted; a bad id is not_found', async () => {
    const { instance, axios } = await plugin();
    assert.ok(Buffer.isBuffer(await instance.downloadCover('1', system())));
    assert.ok(Buffer.isBuffer(await instance.downloadCover('1/series-1.jpg', system())));
    assert.equal(axios.calls.filter((c) => String(c.url).startsWith('https://cdn.mangaupdates.com/')).length, 1, 'the second answer is the cached bytes');
    await assert.rejects(instance.downloadCover('not-an-id', system()), (e) => isPluginError(e) && e.code === 'not_found');
});

test('downloadCover: a series with no cover URL is not_found', async () => {
    const { instance } = await plugin({ wrap: (handler) => (config) => {
        const out = handler(config);
        if (/\/series\/\d+$/.test(String(config.url))) out.data = { ...out.data, image: null };
        return out;
    } });
    await assert.rejects(instance.downloadCover('2', system()), (e) => isPluginError(e) && e.code === 'not_found');
});

test('queryLive: always asks the site (a live query), and a series not found is the not_found arm', async () => {
    const { instance, callsTo } = await plugin();
    await instance.lookup('1', system());
    const live = await instance.queryLive('1', system());
    assert.equal(live.status, 'ok');
    assert.equal(callsTo('get', '/series/1').length, 2);
    assert.deepEqual(await instance.queryLive('901', system()), { status: 'not_found' });
});

test('summarizeEntries answers from each series, never the user\'s lists (Decision 3)', async () => {
    const { instance, axios } = await plugin();
    const out = await instance.summarizeEntries(['1', '901'], system());
    assert.deepEqual(out[0].summary, { label: '5 Volumes (Ongoing)', status: 'ongoing', latestChapter: 42, lastUpdated: new Date(1759276800 * 1000).toISOString() });
    assert.equal(out[1].success, false);
    assert.equal(out[1].error.code, 'not_found');
    assert.equal(axios.calls.some((c) => String(c.url).includes('/lists')), false);
});

test('an HTML answer from MangaUpdates\' edge is a typed error, not parsed; JSON passes', () => {
    assert.throws(
        () => htmlNormalizer({ status: 503, headers: { 'content-type': 'text/html; charset=utf-8' }, data: '<html><head><title>Service Unavailable</title></head><body>Down</body></html>' }),
        (e) => isPluginError(e) && e.code === 'offline' && /infrastructure error: Service Unavailable/.test(e.message),
    );
    assert.doesNotThrow(() => htmlNormalizer({ status: 400, headers: { 'content-type': 'application/json' }, data: { error: 'bad request' } }));
});
