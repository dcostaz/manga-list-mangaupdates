'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { buildRuntimePluginPackage, locateTracker } = require('../../scripts/build-runtime-plugin-package.cjs');

test('the package holds the three layers, the manifest twice, the merged settings, the icon, and no SDK', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mangaupdates-build-'));
    try {
        const { id } = locateTracker();
        const { outputPath } = await buildRuntimePluginPackage({ outputPath: path.join(dir, 'out.zip') });
        const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
        const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
        const reg = `apiwrappers/reg-${id}`;
        assert.deepEqual(names, [
            'images/mangaupdates-icon.svg',
            `${reg}/client-${id}.cjs`,
            `${reg}/${id}-api-settings.json`,
            `${reg}/mapping-${id}.cjs`,
            `${reg}/plugin-${id}.cjs`,
            `${reg}/plugin-package.json`,
            'plugin-package.json',
        ].sort());
        const root = JSON.parse(await zip.file('plugin-package.json').async('string'));
        const beside = JSON.parse(await zip.file(`${reg}/plugin-package.json`).async('string'));
        assert.deepEqual(root, beside);
        assert.equal(root.entrypoints.pluginModule, `${reg}/plugin-${id}.cjs`);
        assert.equal(root.pluginContractVersion, '4.0.0');
        const settings = JSON.parse(await zip.file(`${reg}/${id}-api-settings.json`).async('string'));
        assert.deepEqual(Object.keys(settings).sort(), ['metadata', 'schema', 'settings']);
        assert.equal(settings.metadata.componentName, 'MangaUpdatesAPI', 'the settings component keeps its name');
        for (const deleted of ['cache.enabled', 'cache.provider', 'retry.retryableErrors', 'ui.credentialsTemplate', 'resilience.healthCheck.enabled', 'rateLimit.perEndpoint.series', 'api.endpoints.seriesImage.template']) {
            assert.equal(settings.settings[deleted], undefined, `${deleted} does not ship (Decision 5)`);
        }
        for (const status of ['READING', 'COMPLETED', 'PLAN_TO_READ', 'ON_HOLD', 'DROPPED', 'RE_READING']) {
            assert.equal(settings.settings[`statusMapping.${status}`], null, `statusMapping.${status}: the custom-list override is empty by default`);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
