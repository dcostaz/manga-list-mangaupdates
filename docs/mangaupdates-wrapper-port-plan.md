# MangaUpdates Wrapper Port Plan

## Goal
Port MangaUpdates wrapper behavior from host source to runtime package implementation in a controlled, test-first sequence.

Source wrapper:
- d:/manga-list/cls/apiwrappers/reg-mangaupdates/api-wrapper-mangaupdates.cjs

Runtime target wrapper:
- d:/manga-list-mangaupdates/src/runtime/apiwrappers/reg-mangaupdates/api-wrapper-mangaupdates.cjs

Runtime architecture reference for consistency:
- d:/manga-list-mangadex/src/runtime/apiwrappers/reg-mangadex/api-wrapper-mangadex.cjs
- d:/manga-list-mangadex/src/runtime/apiwrappers/reg-mangadex/tracker-module.cjs

## Architecture Rules (Must Hold)
1. Keep runtime package self-contained.
2. No host-only imports such as app-root-path paths into manga-list internals.
3. Keep runtime module contract stable through tracker-module exports (WrapperClass, SettingsClass, MapperClass).
4. Keep settings source split (definition and values) and runtime bundle merged settings only.
5. Keep DTO mapping responsibilities in mapper file, not wrapper orchestration.
6. Preserve error normalization shape and response contracts expected by host runtime loader.
7. Treat mapper as the canonical standardization boundary for manga-list-facing DTO exposure.
8. Enforce settings baseline parity for communication, caching, and error handling controls even when tracker APIs differ.

## Settings Baseline (Cross-Tracker Foundation)
This baseline must be aligned between MangaDex runtime and MangaUpdates runtime, while allowing tracker-specific endpoint and method differences.

Baseline settings groups that must remain consistent in intent and structure:
1. Communication settings:
	- base URL and endpoint template model
	- connection timeout settings
	- optional endpoint throttle controls
2. Caching settings:
	- cache enabled/provider controls
	- TTL keys used by wrapper read/search flows
	- token/session cache policy controls
3. Error handling and resilience settings:
	- retry enabled/max attempts/backoff policy
	- retryable error definitions
	- rate limit controls (global and per-endpoint)
	- resilience flags (circuit breaker and health-check families where applicable)

Allowed tracker-specific variance:
1. Endpoint names and URL templates.
2. Authentication method details (token/session shapes).
3. Tracker-specific operations and payload keys.
4. Tracker-specific status values and mapping keys.

## Function Inventory From Source Wrapper
Initialization and setup:
1. constructor (line 70)
2. _setupAxiosInterceptor (line 95)
3. static init (line 140)
4. static serviceName getter (line 173)

Authentication and token/cache helpers:
1. testCredentials (line 194)
2. refresh (line 235)
3. _fetchNewToken (line 266)
4. _extractToken (line 298)
5. _cacheToken (line 308)
6. _getTokenTTL (line 323)

Read and status retrieval:
1. getSeriesUrl (line 210)
2. getUserLists (line 348)
3. getListSeries (line 394)
4. getSeriesListStatus (line 450)
5. getUserProgress (line 523)
6. getUserProgressRaw (line 556)
7. getReadingStatusFromListId (line 570)
8. getSeriesById (line 623)
9. getSeriesByIdRaw (line 646)
10. _normalizeSeriesData (line 671)
11. getSerieDetail (line 701)
12. serieSearch (line 751)
13. getSeriesCover (line 809)

Write and subscription:
1. updateSeries (line 827)
2. updateSeriesCover (line 862)
3. deleteSeriesCover (line 899)
4. updateListSeries (line 942)
5. addListSeries (line 1012)
6. updateSerieRating (line 1055)
7. updateStatus (line 1106)
8. subscribeToReadingList (line 1553)
9. setUserProgress (line 1644)

Search and cover orchestration:
1. searchTrackers (line 1197)
2. searchTrackersRaw (line 1427)
3. _findExactMatch (line 1942)
4. searchCovers (line 1759)
5. downloadCover (line 1878)

## Current Runtime Target Status
Implemented now in target runtime wrapper:
1. static init
2. searchTrackersRaw (placeholder)
3. getSeriesByIdRaw (placeholder)
4. getUserProgressRaw (placeholder)

Everything else is pending port.

## Port Waves

### Wave 0: Contract Lock and Test Harness
Objective:
- Freeze runtime contract and create focused tests before behavior port.

Status:
- In progress (started 2026-04-06).
- Added initial test harness suites for wrapper, mapper, settings, and baseline matrix validation.

Tasks:
1. Add wrapper unit tests for method contracts and error behavior.
2. Add mapper tests for DTO conversion parity from expected raw payloads.
3. Add settings tests for required fields from merged settings payload.
4. Add settings-baseline matrix tests ensuring communication/caching/error-handling keys exist and are typed as expected.

Exit gate:
- Existing build tests pass plus new contract tests pass.
- Settings-baseline matrix passes for MangaUpdates and MangaDex runtime packages.

### Wave 1: Runtime Infrastructure and Init Path
Objective:
- Port setup and init behavior without host-only dependencies.

Status:
- In progress (started 2026-04-06).
- Runtime wrapper now has instance HTTP client + interceptor wiring, settings path init fallback,
	serviceName getter, and baseline credential test path.

Functions:
1. constructor
2. _setupAxiosInterceptor
3. static init
4. static serviceName
5. testCredentials

Notes:
- Replace host Redis dependency with runtime-safe token/cache adapter interface.
- Keep axios interceptor behavior consistent with source wrapper error semantics.

Exit gate:
- Init, interceptor, and credential tests pass.

### Wave 2: Auth and Token Lifecycle
Objective:
- Port token acquisition and caching pipeline.

Status:
- In progress (started 2026-04-06).
- Added runtime-safe token/cache adapter seam and token lifecycle methods:
	`refresh`, `_getTokenCacheKey`, `_extractToken`, `_cacheToken`, `_getTokenTTL`, and cache-aware `_fetchNewToken`.
- Added dedicated Wave 2 token lifecycle tests.

Functions:
1. refresh
2. _fetchNewToken
3. _extractToken
4. _cacheToken
5. _getTokenTTL

Notes:
- Keep key naming and TTL semantics compatible with future migration tests.
- Add fallback behavior tests for missing endpoint config and auth failures.

Exit gate:
- Token lifecycle tests pass and no API surface regressions.

### Wave 3: Read Pipeline and Series Resolution
Objective:
- Port core read APIs and normalization pipeline.

Status:
- In progress (started 2026-04-06).
- Added baseline read-path behavior for:
	`getSeriesUrl`, `getUserLists`, `getSeriesListStatus`, `getReadingStatusFromListId`, `getUserProgress`, `getUserProgressRaw`, `getSerieDetail`, `getSeriesById`, `getSeriesByIdRaw`, `serieSearch`, and `getSeriesCover`.
- Added Wave 3 baseline tests for token-backed list/status/progress flows.

Functions:
1. getSeriesUrl
2. getUserLists
3. getListSeries
4. getSeriesListStatus
5. getUserProgress
6. getReadingStatusFromListId
7. getSeriesById
8. getSeriesByIdRaw
9. _normalizeSeriesData
10. getSerieDetail
11. serieSearch
12. getSeriesCover

Notes:
- Keep raw response wrappers consistent for mapper consumption.
- Maintain cache hit and refresh behavior where feasible.

Exit gate:
- Read APIs tested with mocked HTTP and stable DTO inputs.

### Wave 4: Write, Update, and Subscription Flows
Objective:
- Port all mutation paths used by progress sync flows.

Status:
- In progress (started 2026-04-06).
- Added baseline mutation behavior for:
	`updateListSeries`, `addListSeries`, and `updateStatus`.
- Added Wave 4 baseline tests for payload shaping and status-list resolution.

Functions:
1. updateSeries
2. updateSeriesCover
3. deleteSeriesCover
4. updateListSeries
5. addListSeries
6. updateSerieRating
7. updateStatus
8. subscribeToReadingList
9. setUserProgress

Notes:
- Validate payload shaping rules and status mapping behavior.
- Include retry and API error surface tests.

Exit gate:
- Mutation flow tests pass for add, update, and progression changes.

### Wave 5: Search Orchestration and Cover Transfer
Objective:
- Port high-level search matching and cover transfer operations.

Functions:
1. searchTrackers
2. searchTrackersRaw (replace placeholder with full logic)
3. _findExactMatch
4. searchCovers
5. downloadCover

Notes:
- Keep matching behavior deterministic and test with title variants.
- Keep progress callback event shape stable.

Exit gate:
- Search and cover integration tests pass.

## MangaDex Runtime Consistency Checkpoints
Check at each wave:
1. Wrapper, settings, mapper, tracker-module roles remain separated.
2. Runtime package build output remains identical in structure to mangadex baseline (except tracker-specific names).
3. settingsFile entrypoint remains generated merged settings artifact.
4. DTO contract and settings contract version enforcement remain centralized via trackerdtocontract module.
5. Settings baseline parity maintained for communication/caching/error handling groups.
6. Mapper output remains the standard manga-list exposure contract regardless of tracker API differences.

## Definition of Done
1. Placeholder logic removed from runtime MangaUpdates wrapper.
2. Function-level behavior parity reached for required source methods.
3. Build and test suites pass in manga-list-mangaupdates.
4. Runtime artifact installs and loads through manga-list runtime loader.
5. Comparison report generated against mangadex runtime structure confirming architectural consistency.
6. Settings baseline parity report completed and passing for:
	- communication settings
	- caching settings
	- error-handling and resilience settings
7. Tracker-specific API differences are documented explicitly (methods/endpoints/payload deltas) and verified as intentional.
8. Mapper contract parity is validated so manga-list receives standardized DTOs independent of tracker-specific API structure.
