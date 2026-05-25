# MangaUpdates Settings Reference

This document describes the tracker-specific settings declared by the `manga-list-mangaupdates` runtime package.

Settings contract version: **1.0.0** (declared in `src/runtime/apiwrappers/trackerdtocontract.cjs`).

---

## Three-Tier Model

| Tier | Description |
|------|-------------|
| 1 — Package defaults | Keys and standalone-viable defaults baked into this package (`mangaupdates-api-settings.definition.json` merged with `mangaupdates-api-settings.values.json`) |
| 2 — Host overrides | User-edited per-tracker values stored by the host in its override file; only `readOnly=false` keys may be written |
| 3 — Host injection | Common cross-tracker defaults from `TrackerCommonSettings` in the host; merged at init time |

Effective resolution order: Tier 2 wins over Tier 3 wins over Tier 1.

During development (unit tests, integration tests in this repo) only Tier 1 is active. Tier 1 defaults must therefore be complete and standalone-viable without Tier 3 present.

---

## Tracker Identity

| Key | Default | Notes |
|-----|---------|-------|
| `ui.label` | `MangaUpdates` | Display name shown in the host UI |
| `ui.icon` | `images/manga-updates.svg` | Icon path relative to the runtime package |
| `ui.credentialsTemplate` | See below | Session credential form schema |
| `credentials.primary` | `null` | Managed via host keychain; never stored in settings file |

### Credential fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | text | yes | MangaUpdates account username |
| `password` | password | yes | Account password used for session authentication |

---

## Authentication Architecture

MangaUpdates uses session/login-based authentication. The wrapper calls the `login` endpoint to obtain a session token, which is cached and used for all subsequent authenticated requests. No OAuth client credentials are required.

---

## API Endpoints

All `api.*` keys are locked (`readOnly=true`, `isBasic=false`, `category=network`) and may only be changed by updating the package source and releasing a new runtime zip.

| Key | Default | Order | Description |
|-----|---------|-------|-------------|
| `api.baseUrl` | `https://api.mangaupdates.com/v1` | 200 | MangaUpdates API v1 base URL |
| `api.endpoints.login.template` | `${baseUrl}/account/login` | 210 | Login endpoint for session token authentication |
| `api.endpoints.getUserLists.template` | `${baseUrl}/lists` | 220 | Retrieve user's reading lists |
| `api.endpoints.listSearch.template` | `${baseUrl}/lists/${list_id}/search` | 230 | Search series within a specific list |
| `api.endpoints.listGetSeriesItem.template` | `${baseUrl}/lists/series/${series_id}?unrenderedFields=true` | 240 | Get series status on user's list |
| `api.endpoints.listUpdateSeries.template` | `${baseUrl}/lists/series/update` | 250 | Update series on user's list |
| `api.endpoints.listAddSeries.template` | `${baseUrl}/lists/series` | 260 | Add series to user's list |
| `api.endpoints.series.template` | `${baseUrl}/series/${series_id}` | 270 | Get full series details by ID |
| `api.endpoints.seriesSearch.template` | `${baseUrl}/series/search` | 280 | Search for series by title/metadata |
| `api.endpoints.seriesImage.template` | `${baseUrl}/series/${series_id}/image` | 285 | Upload or remove series cover image |
| `api.endpoints.updateSerieRating.template` | `${baseUrl}/series/${series_id}/rating` | 290 | Update user's rating for a series |

---

## Status Mappings

MangaUpdates uses **integer** status codes. All `statusMapping.*` keys are locked (`readOnly=true`).

| Host status | MangaUpdates value | Order |
|-------------|-------------------|-------|
| `READING` | `0` | 50 |
| `COMPLETED` | `2` | 60 |
| `PLAN_TO_READ` | `1` | 70 |
| `ON_HOLD` | `4` | 80 |
| `DROPPED` | `3` | 90 |
| `RE_READING` | `101` | 100 |

---

## Standalone Defaults for Shared Keys

These are the Tier 1 standalone defaults for the 44 shared keys required by the canonical contract. Tier 3 may override any of these at runtime for the host's cross-tracker policy.

### Connection

| Key | Default | Order |
|-----|---------|-------|
| `connection.timeout.connect` | 5000 ms | 10 |
| `connection.timeout.request` | 30000 ms | 20 |
| `connection.timeout.search` | 60000 ms | 30 |
| `connection.pool.keepAlive` | `true` | 40 |
| `connection.pool.maxSockets` | 10 | 50 |
| `connection.pool.maxFreeSockets` | 5 | 60 |
| `resilience.healthCheck.endpoint` | `"/series/1"` | 70 |

### Cache

| Key | Default | Order |
|-----|---------|-------|
| `cache.enabled` | `true` | 10 |
| `cache.provider` | `"memory"` | 20 |
| `cache.ttl.default` | 3600 s | 30 |

### Rate Limit — Global

| Key | Default | Order | Notes |
|-----|---------|-------|-------|
| `rateLimit.global.enabled` | `true` | 100 | |
| `rateLimit.global.maxConcurrent` | 5 | 110 | |
| `rateLimit.global.maxPerSecond` | 10 | 120 | MangaUpdates rate limit is not publicly documented; conservative default |
| `rateLimit.global.maxPerMinute` | 100 | 130 | |
| `rateLimit.global.queueSize` | 50 | 140 | |

### Rate Limit — Per Endpoint (shared)

| Key | Default | Order |
|-----|---------|-------|
| `rateLimit.perEndpoint.enabled` | `true` | 200 |
| `rateLimit.perEndpoint.defaultDelay` | 1000 ms | 210 |

### Retry

| Key | Default | Order |
|-----|---------|-------|
| `retry.enabled` | `true` | 300 |
| `retry.maxAttempts` | 3 | 310 |
| `retry.backoff.type` | `"exponential"` | 320 |
| `retry.backoff.initialDelay` | 1000 ms | 330 |
| `retry.backoff.multiplier` | 2 | 340 |
| `retry.backoff.maxDelay` | 10000 ms | 350 |
| `retry.retryableErrors` | `["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", 502, 503, 504, 429]` | 360 |

### Resilience — Circuit Breaker

| Key | Default | Order |
|-----|---------|-------|
| `resilience.circuitBreaker.enabled` | `false` (disabled until implemented) | 400 |
| `resilience.circuitBreaker.failureThreshold` | 5 | 410 |
| `resilience.circuitBreaker.failureWindow` | 10000 ms | 420 |
| `resilience.circuitBreaker.openDuration` | 30000 ms | 430 |

### Resilience — Health Check

| Key | Default | Order |
|-----|---------|-------|
| `resilience.healthCheck.enabled` | `false` (disabled until implemented) | 500 |
| `resilience.healthCheck.interval` | 60000 ms | 510 |

### Search

| Key | Default | Order |
|-----|---------|-------|
| `search.fuzzyThreshold` | 0.60 | 520 |
| `search.containmentScore` | 0.85 | 530 |
| `search.candidateLimit` | 5 | 540 |
| `search.exactMatchPolicy` | `"first"` | 550 |

---

## Tracker-Scoped Locked Keys

These keys encode MangaUpdates-specific cache and rate-limit topology. They are locked (`readOnly=true`, `isBasic=false`, `category=performance`, `order ≥ 600`) and may only be changed by updating the package.

### Cache TTL

| Key | Default | Order | Description |
|-----|---------|-------|-------------|
| `cache.ttl.seriesMetadata` | 86400 s (24 h) | 820 | Series metadata — stable |
| `cache.ttl.searchResults` | 3600 s (1 h) | 830 | Search results — changes moderately |
| `cache.ttl.readingLists` | 1800 s (30 min) | 840 | Reading list contents — user modifies frequently |
| `cache.ttl.userLists` | 1800 s (30 min) | 850 | User's list names — user creates new lists |
| `cache.ttl.sessionToken` | 43200 s (12 h) | 860 | Session token — matches API expiry |
| `cache.ttl.coverUrls` | 604800 s (7 d) | 870 | Cover image URLs — never change |

### Endpoint-Coupled Rate Limits

Each key pairs with the corresponding `api.endpoints.<name>` entry.

| Key | Default | Order | Notes |
|-----|---------|-------|-------|
| `rateLimit.perEndpoint.login` | 0 ms | 880 | Only called once per session |
| `rateLimit.perEndpoint.getUserLists` | 500 ms | 890 | Cheap list-fetch operation |
| `rateLimit.perEndpoint.listSearch` | 1000 ms | 900 | Moderate cost |
| `rateLimit.perEndpoint.listGetSeriesItem` | 1000 ms | 910 | |
| `rateLimit.perEndpoint.listUpdateSeries` | 1000 ms | 920 | |
| `rateLimit.perEndpoint.listAddSeries` | 1000 ms | 930 | |
| `rateLimit.perEndpoint.series` | 1000 ms | 940 | |
| `rateLimit.perEndpoint.seriesSearch` | 1500 ms | 950 | Higher delay — expensive search operation |
| `rateLimit.perEndpoint.seriesImage` | 1000 ms | 960 | |
| `rateLimit.perEndpoint.updateSerieRating` | 1000 ms | 970 | |

---

## Settings Contract Compliance

This package passes host validation with 0 errors and 0 warnings against `TRACKER_SETTINGS_CONTRACT_VERSION` 1.0.0.
