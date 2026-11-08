'use strict';

/**
 * Live checks against api.mangaupdates.com — run by hand, never in CI (Plan-2026Q4-tracker-plugin-standardization,
 * Phase 4: "the manual integration tests are kept and run once"). Read-only: nothing here writes to a list or a
 * rating. MangaUpdates' search is authenticated (the manifest's searchOptions.requiresCredential), so both halves
 * need an account:
 *
 *   ENABLE_REAL_SEARCH_TEST=1 MU_TEST_USERNAME=... MU_TEST_PASSWORD=... [MU_TEST_SEARCH_QUERY="..."] npm run test:integration
 *   ENABLE_REAL_LIBRARY_TEST=1 MU_TEST_USERNAME=... MU_TEST_PASSWORD=... npm run test:integration
 *
 * The plugin is built exactly as the host builds it; its HTTP client is Node's fetch behind an axios-shaped
 * adapter, so the run needs no dependency.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { locateTracker } = require('../../scripts/build-runtime-plugin-package.cjs');

const tracker = locateTracker();
const descriptor = require(path.join(tracker.dir, `plugin-${tracker.id}.cjs`));
const settings = JSON.parse(fs.readFileSync(path.join(tracker.dir, `${tracker.id}-api-settings.values.json`), 'utf8')).settings;

const hasAccount = !!process.env.MU_TEST_USERNAME && !!process.env.MU_TEST_PASSWORD;
const searchSkip = process.env.ENABLE_REAL_SEARCH_TEST !== '1' || process.env.CI === 'true' || !hasAccount;
const librarySkip = process.env.ENABLE_REAL_LIBRARY_TEST !== '1' || process.env.CI === 'true' || !hasAccount;
const credential = () => ({ username: String(process.env.MU_TEST_USERNAME), password: String(process.env.MU_TEST_PASSWORD) });

/** An axios-shaped client over fetch: request(config) → { status, data, headers }, throws with `response` ≥ 400. */
const fetchAxios = {
    /** @param {Record<string, any>} config */
    async request(config) {
        const url = new URL(config.url);
        for (const [key, value] of Object.entries(config.params || {})) if (value !== undefined) url.searchParams.set(key, String(value));
        // The plugin may name Content-Type itself: add one only when no casing of it is there (fetch would join two).
        /** @type {Record<string, string>} */
        const requestHeaders = { ...(config.headers || {}) };
        const hasBody = config.data !== undefined && config.data !== null;
        if (hasBody && !Object.keys(requestHeaders).some((h) => h.toLowerCase() === 'content-type')) requestHeaders['content-type'] = 'application/json';
        const response = await fetch(url, {
            method: String(config.method || 'get').toUpperCase(),
            headers: requestHeaders,
            body: hasBody ? JSON.stringify(config.data) : undefined,
            signal: config.signal || AbortSignal.timeout(config.timeout || 30000),
        });
        const headers = Object.fromEntries(response.headers.entries());
        const data = config.responseType === 'arraybuffer'
            ? Buffer.from(await response.arrayBuffer())
            : (headers['content-type'] || '').includes('json') ? await response.json() : await response.text();
        const out = { status: response.status, data, headers, config };
        if (response.status >= 400) {
            const error = new Error(`Request failed with status code ${response.status}`);
            /** @type {any} */ (error).response = out;
            throw error;
        }
        return out;
    },
};

async function plugin() {
    return descriptor.WrapperClass.init({ context: { utils: {}, http: fetchAxios, cache: null }, serviceSettings: settings });
}

/** @param {unknown} cred @param {string} scope */
const context = (cred, scope) => ({ credential: cred, identity: `manual-${scope}`, scope, signal: null });

test('live: search answers candidates with a 0–1 confidence and a canonical URL; lookup and summary from the series', { skip: searchSkip }, async () => {
    const instance = await plugin();
    const results = await instance.search(process.env.MU_TEST_SEARCH_QUERY || 'One Piece', undefined, context(credential(), 'system'));
    assert.ok(results.length > 0, 'at least one candidate');
    for (const r of results) {
        assert.ok(r.confidence >= 0 && r.confidence <= 1);
        assert.match(String(r.canonicalUrl), /^https:\/\/www\.mangaupdates\.com\//);
    }
    const detail = await instance.lookup(results[0].pluginEntryId, context(credential(), 'system'));
    assert.equal(detail.pluginEntryId, results[0].pluginEntryId);
    const summary = await instance.summarizeEntries([results[0].pluginEntryId], context(credential(), 'system'));
    assert.equal(summary[0].success, true);
    console.log(`search: ${results.length} candidates; first '${results[0].title}' (${results[0].pluginEntryId}), summary ${JSON.stringify(summary[0].summary)}`);
});

test('live: the login tests good, and every list comes back with MangaUpdates\' list types as tokens and list ids', { skip: librarySkip }, async () => {
    const instance = await plugin();
    assert.equal(await instance.testCredentials(credential()), true);
    const list = await instance.getReadingList(context(credential(), 'user'));
    const tokens = new Set(list.map((/** @type {any} */ e) => e.status));
    for (const token of tokens) {
        if (token !== null) assert.ok(token in tracker.manifest.syncOptions.statusVocabulary.pull, `'${token}' is in the pull table`);
    }
    const lists = new Set(list.map((/** @type {any} */ e) => `${e.listId}:${e.status}`));
    console.log(`library: ${list.length} entries; lists (id:type) seen: ${[...lists].join(', ')}`);
});
