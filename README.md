# manga-list-mangaupdates

Runtime tracker package source for MangaUpdates.

This repository builds a runtime-installable zip artifact compatible with manga-list `TrackerPackageLoader`.

## Build

```bash
npm run build
```

Optional build flags:

```bash
node scripts/build-runtime-tracker-package.cjs --output ./dist/mangaupdates-runtime.zip --host-api-version 1.0.0
```

Build output contains:

1. `tracker-package.json`
2. `apiwrappers/trackerdtocontract.cjs`
3. `apiwrappers/reg-mangaupdates/api-wrapper-mangaupdates.cjs`
4. `apiwrappers/reg-mangaupdates/api-settings-mangaupdates.cjs`
5. `apiwrappers/reg-mangaupdates/mangaupdates-api-settings.json` (generated effective settings used at runtime; not an authored source file)
6. `apiwrappers/reg-mangaupdates/mapper-mangaupdates.cjs`
7. `apiwrappers/reg-mangaupdates/tracker-module.cjs`

Settings source of truth in this repository is split into:

1. `src/runtime/apiwrappers/reg-mangaupdates/mangaupdates-api-settings.definition.json`
2. `src/runtime/apiwrappers/reg-mangaupdates/mangaupdates-api-settings.values.json`

The build script validates and merges both source files into the runtime payload:
`apiwrappers/reg-mangaupdates/mangaupdates-api-settings.json`.

Note: Runtime manifest entrypoint `settingsFile` points to the generated effective file above,
while repository source of truth remains the definition/values pair. The definition and values source files are not bundled into the runtime zip artifact.

Contract version governance:

1. DTO contract version comes from `src/runtime/apiwrappers/trackerdtocontract.cjs` (`TRACKER_DTO_CONTRACT_VERSION`).
2. Settings contract version is centrally defined in the same file (`TRACKER_SETTINGS_CONTRACT_VERSION`).
3. Build enforces that both `mangaupdates-api-settings.definition.json` and `mangaupdates-api-settings.values.json`
	use `metadata.settingsContractVersion` matching `TRACKER_SETTINGS_CONTRACT_VERSION`.
4. Build fails fast on mismatch to prevent contract drift.

Type definitions governance:

1. Tracker-local typedefs live in `types/trackertypedefs.d.ts`.
2. Runtime classes explicitly reference these typedefs using JSDoc `import(...)` types.
3. The repository does not rely on manga-list type definition files for runtime wrapper, mapper, settings, or tracker-module contracts.

## Test

```bash
npm test
```

Wave 0 adds dedicated contract harness suites:

1. `tests/wave0-wrapper-contract.test.cjs`
2. `tests/wave0-mapper-contract.test.cjs`
3. `tests/wave0-settings-contract.test.cjs`
4. `tests/wave0-settings-baseline-matrix.test.cjs`

Note: The baseline matrix suite validates MangaUpdates locally and validates MangaDex when
`../manga-list-mangadex` exists in the same parent directory layout.

Wave 1 adds runtime init and infrastructure behavior suite:

1. `tests/wave1-runtime-init.test.cjs`

This suite covers init-path settings resolution, interceptor error normalization,
credential validation behavior, and static service identity.

Wave 2 adds token lifecycle suite:

1. `tests/wave2-token-lifecycle.test.cjs`

This suite covers refresh toggle persistence, token cache key + TTL semantics,
token extraction/caching, and cache-first token fetch behavior.

Wave 3 baseline adds read-path infrastructure suite:

1. `tests/wave3-read-baseline.test.cjs`

This suite covers credential-backed token retrieval, user-list read/caching,
list status retrieval, list-id to status mapping, progress normalization,
and series URL extraction contract behavior.

## Port Plan

Structured function-by-function port plan for MangaUpdates wrapper migration:

1. d:/manga-list-mangaupdates/docs/mangaupdates-wrapper-port-plan.md
