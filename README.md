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

## Test

```bash
npm test
```
