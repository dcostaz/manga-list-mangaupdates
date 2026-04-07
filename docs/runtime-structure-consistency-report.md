# MangaUpdates vs MangaDex Runtime Structure Consistency Report

Date: 2026-04-07

## Scope
This report verifies runtime package architecture consistency between:

1. MangaUpdates runtime package in this repository.
2. MangaDex runtime package in the sibling repository.

The goal is structural consistency, not endpoint-level identity.

## Evidence Sources

MangaUpdates sources:
1. src/runtime/apiwrappers/reg-mangaupdates/tracker-module.cjs
2. src/runtime/apiwrappers/trackerdtocontract.cjs
3. tests/build-runtime-tracker-package.test.cjs
4. tests/wave0-settings-baseline-matrix.test.cjs

MangaDex sources:
1. ../manga-list-mangadex/src/runtime/apiwrappers/reg-mangadex/tracker-module.cjs
2. ../manga-list-mangadex/src/runtime/apiwrappers/trackerdtocontract.cjs
3. ../manga-list-mangadex/tests/build-runtime-tracker-package.test.cjs

## Consistency Matrix

1. Wrapper, settings, mapper, tracker-module role separation: PASS
Details: both packages export WrapperClass, SettingsClass, MapperClass from tracker-module and keep DTO mapping in mapper modules.

2. Runtime build artifact structure parity: PASS
Details: both build tests assert the same seven-file zip layout pattern with tracker-specific folder and file names.

3. Generated settings file entrypoint usage: PASS
Details: both manifests point settingsFile to generated effective settings JSON, not source definition or values JSON.

4. Centralized contract governance parity: PASS
Details: both trackerdtocontract modules export TRACKER_DTO_CONTRACT_VERSION and TRACKER_SETTINGS_CONTRACT_VERSION, currently 1.0.0.

5. Baseline settings parity families (communication, caching, resilience/error handling): PASS
Details: Wave 0 settings baseline matrix and build settings tests validate required baseline key families for MangaUpdates and MangaDex.

6. Mapper as canonical DTO boundary: PASS
Details: wrapper methods return raw transport envelopes while mapper contract tests validate standardized DTO outputs.

## Intentional Tracker-Specific Differences

1. Authentication and token strategy differs by tracker API contract.
2. Endpoint templates and per-endpoint rate limit keys differ by API surface.
3. Status mapping values differ (numeric list IDs in MangaUpdates vs MangaDex status values).
4. Cover/search workflows differ where tracker APIs expose different capabilities and payloads.

These differences are intentional and do not violate runtime architecture parity.

## Host Loader Verification (Definition of Done Item 4)

Verification command executed in manga-list host repository (temporary appData root):

1. Build package: `npm run build` in manga-list-mangaupdates.
2. Install + activate package via TrackerPackageLoader.installRuntimePackage.
3. Validate package visibility via TrackerPackageLoader.listRuntimePackages.
4. Reload package via TrackerPackageLoader.reloadRuntimePackage.
5. Remove extracted package and zip via TrackerPackageLoader.removeRuntimePackage.

Observed verification summary:

```json
{
	"install": {
		"success": true,
		"packageName": "manga-list-mangaupdates-runtime-1.0.0",
		"activated": true
	},
	"list": {
		"count": 1,
		"isExtracted": true,
		"hasZip": true,
		"hostCompatible": true,
		"dtoCompatible": true
	},
	"reload": {
		"moduleKeys": [
			"mangaupdates"
		],
		"loadedServices": [
			"mangaupdates"
		],
		"hasWrapperClass": true,
		"hasSettingsClass": true,
		"hasMapperClass": true
	}
}
```

## Conclusion

Definition of Done item 5 is satisfied:
Comparison report generated against MangaDex runtime structure confirming architectural consistency.

Definition of Done item 4 is satisfied:
Runtime artifact installs and loads through manga-list runtime loader with compatible host/dto contracts and runtime module exports.
