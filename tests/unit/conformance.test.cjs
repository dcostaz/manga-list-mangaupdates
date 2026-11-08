'use strict';

/**
 * The contract suite (host-capability-contract.md, through @manga-list/plugin-sdk/testing) against MangaUpdates,
 * with the fixture source.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runConformance } = require('@manga-list/plugin-sdk/testing');
const { locateTracker } = require('../../scripts/build-runtime-plugin-package.cjs');
const { createSource, LIBRARY } = require('../fixtures/mangaupdates-source.cjs');

const tracker = locateTracker();
const descriptor = require(path.join(tracker.dir, `plugin-${tracker.id}.cjs`));
const values = JSON.parse(fs.readFileSync(path.join(tracker.dir, `${tracker.id}-api-settings.values.json`), 'utf8'));

/** Settings for a fast run: throttles and backoff off. */
const fastSettings = () => {
    /** @type {Record<string, unknown>} */
    const s = { ...values.settings, 'retry.backoff.initialDelay': 1, 'retry.backoff.maxDelay': 2, 'retry.maxAttempts': 2, 'rateLimit.perEndpoint.defaultDelay': 0 };
    for (const key of Object.keys(s)) if (key.endsWith('.throttle')) s[key] = 0;
    return s;
};

/**
 * The inputs the suite uses, ids the fixture knows. Plain JSON (an omitted option is null), so the host check's
 * SUITE_INPUTS is this very text.
 */
const INPUTS_JSON = '{"search":["Series 1",null],"lookup":["1"],"enrich":[["1","2"]],"searchCovers":[{"title":"Series 1"},null],"downloadCover":["1"],"pullProgress":["1"],"pushProgress":[[{"pluginEntryId":"1","chapter":12,"rating":8.5}]],"subscribe":[[{"pluginEntryId":"6","status":"read"}]],"unsubscribe":[["1"]],"queryLive":["1"],"summarizeEntries":[["1","2"]]}';
const INPUTS = JSON.parse(INPUTS_JSON);

test('MangaUpdates passes the contract suite with 0 failures', async () => {
    const source = createSource();
    const report = await runConformance({
        WrapperClass: descriptor.WrapperClass,
        descriptor,
        manifest: tracker.manifest,
        settings: fastSettings(),
        source: source.handler,
        credentials: [{ username: 'mu-alpha', password: 'alpha-pass' }, { username: 'mu-beta', password: 'beta-pass' }],
        inputs: INPUTS,
        expect: { readingListLength: LIBRARY.length },
    });
    assert.deepEqual(report.failed, []);
    for (const id of ['sync.list.returns-the-whole-library', 'F3.getReadingList-without-a-credential-is-rejected', 'F11.no-identity-leaks-across-calls', 'F11.cache-keys-name-the-scope', 'result.summarizeEntries', 'result.pullProgress', 'result.testCredentials', 'status.subscribe-refuses-a-host-status', 'F12.search.lookup.has-lookup']) {
        assert.ok(report.passed.includes(id), `passed ${id}`);
    }
});

module.exports = { INPUTS, INPUTS_JSON };
