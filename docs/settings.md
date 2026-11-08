# MangaUpdates Settings Reference

The settings document this plugin ships (`mangaupdates-api-settings.definition.json` merged with
`mangaupdates-api-settings.values.json` by the build), under `PLUGIN_SETTINGS_CONTRACT_VERSION` 1.0.0. The component
name is `MangaUpdatesAPI`. Which keys survive, and who reads them, is
`Plan-2026Q4-tracker-plugin-standardization.md` Decision 5.

---

## Who reads what

| Set | Keys | Read by |
|---|---|---|
| SDK-read | `connection.timeout.*`, `connection.pool.*`, `retry.enabled`, `retry.maxAttempts`, `retry.backoff.*`, `rateLimit.global.*`, `rateLimit.perEndpoint.{enabled,defaultDelay}`, `api.endpoints.<name>.throttle`, `resilience.circuitBreaker.*` | `@manga-list/plugin-sdk`'s HTTP layer, on every request |
| Client-read | `api.baseUrl`, `api.endpoints.<name>.template`, `api.endpoints.listSearch.perPage`, `cache.ttl.*`, `search.*` | `client-mangaupdates.cjs` |
| Host-read | `ui.label`, `ui.icon`, `credentials.primary`, `statusMapping.*` | the host (its UI; the custom-list override, contract §2.2) |

---

## Identity and credential

| Key | Default | Notes |
|-----|---------|-------|
| `ui.label` | `MangaUpdates` | Display name shown in the host UI |
| `ui.icon` | `images/mangaupdates-icon.svg` | The manifest's `iconPath` |
| `credentials.primary` | `null` | The host's credential button; the secret lives in the host's keychain, never here |

The credential's fields are the manifest's `credentialOptions.fields` (contract §1.4): `username` (text) and
`password` (password), the keys the 3.x `credentialSchema` used, so a stored credential keeps working.

MangaUpdates authenticates with a session: `PUT /account/login` answers a session token, sent as `Authorization:
Bearer`. The plugin holds it in memory per credential slot for `cache.ttl.sessionToken` (12 h) less a minute, never
in the host's cache; a `401` logs in again once and replays the request once.

---

## Status: list types and the custom-list override

The status token is the MangaUpdates list's **type** — `read`, `wish`, `complete`, `unfinished`, `hold` — mapped in the
manifest's `syncOptions.statusVocabulary` (`push` READING → `read`, COMPLETED → `complete`, PLAN_TO_READ → `wish`,
ON_HOLD → `hold`, DROPPED → `unfinished`, RE_READING → none; `pull` the inverse). The list's `list_id` is `listId`.

`statusMapping.<STATUS>` (`READING`, `COMPLETED`, `PLAN_TO_READ`, `ON_HOLD`, `DROPPED`, `RE_READING`) is an
**optional override**: the `list_id` of one of the user's own (custom) lists to use for that status instead of the
typed list. All default to empty (`null`). The host applies it (contract §2.2): on push it sends the `list_id`, which
`subscribe()` accepts in place of a type; on pull it matches an entry's `listId` against the override before its type.
RE_READING has no list type, so it syncs only when its override names a list. The plugin itself never reads these keys.
(The 3.x defaults 0–4 were read as list positions in one place and as ids in another — analysis F18; they are gone.)

---

## API endpoints

All `api.*` keys are locked (`readOnly=true`). Each `api.endpoints.<name>.throttle` is the minimum delay in ms between
two calls to that endpoint, enforced by the SDK.

| Key | Default | Throttle |
|-----|---------|----------|
| `api.baseUrl` | `https://api.mangaupdates.com/v1` | |
| `api.endpoints.login.template` | `${baseUrl}/account/login` | 0 |
| `api.endpoints.getUserLists.template` | `${baseUrl}/lists` | 1000 |
| `api.endpoints.listSearch.template` | `${baseUrl}/lists/${list_id}/search` (`perPage` 500) | 1000 |
| `api.endpoints.listGetSeriesItem.template` | `${baseUrl}/lists/series/${series_id}?unrenderedFields=true` | 1000 |
| `api.endpoints.listUpdateSeries.template` | `${baseUrl}/lists/series/update` | 1000 |
| `api.endpoints.listAddSeries.template` | `${baseUrl}/lists/series` | 1000 |
| `api.endpoints.listRemoveSeries.template` | `${baseUrl}/lists/series/delete` | 1000 |
| `api.endpoints.series.template` | `${baseUrl}/series/${series_id}` | 1000 |
| `api.endpoints.seriesSearch.template` | `${baseUrl}/series/search` | 1500 |
| `api.endpoints.updateSerieRating.template` | `${baseUrl}/series/${series_id}/rating` | 1000 |

A cover image download has no endpoint key: it uses `rateLimit.perEndpoint.defaultDelay`.

---

## Cache (the host's cache, keyed by the call's scope)

| Key | Default | What |
|-----|---------|------|
| `cache.ttl.seriesMetadata` | 86400 s | A series' detail (lookup, enrich, covers, summaries; a live query always asks) |
| `cache.ttl.searchResults` | 3600 s | A search, with its fetch time (`options.refresh` asks again) |
| `cache.ttl.readingLists` | 1800 s | One list's contents; a write to that list clears it |
| `cache.ttl.userLists` | 1800 s | The account's list-of-lists |
| `cache.ttl.sessionToken` | 43200 s | The session token's lifetime (memory only, never the cache) |
| `cache.ttl.coverUrls` | 604800 s | Cover image bytes |
| `cache.ttl.default` | 3600 s | Unread; kept as the shared default |

A series' list membership is never cached: a pull or a write always asks the site.

## Search

| Key | Default | What |
|-----|---------|------|
| `search.fuzzyThreshold` | 0.6 | Similarity (0–1) from which a candidate is a fuzzy match (title-mode cover search takes exact or fuzzy only) |
| `search.containmentScore` | 0.85 | Similarity given when one title contains the other |
| `search.candidateLimit` | 5 | Most candidates a search returns |
| `search.exactMatchPolicy` | `first` | `first`: an exact title match answers alone; `highestScore`: every ranked candidate comes back |

## Connection, retry, rate limit, circuit breaker (SDK-read)

`connection.timeout.connect` 5000, `.request` 30000, `.search` 60000 ms; `connection.pool.keepAlive` true,
`.maxSockets` 10, `.maxFreeSockets` 5; `retry.enabled` true, `.maxAttempts` 3, `retry.backoff.type` exponential,
`.initialDelay` 1000, `.maxDelay` 10000, `.multiplier` 2; `rateLimit.global.enabled` true, `.maxConcurrent` 5,
`.maxPerSecond` 10, `.maxPerMinute` 100, `.queueSize` 50; `rateLimit.perEndpoint.enabled` true, `.defaultDelay` 1000;
`resilience.circuitBreaker.enabled` false, `.failureThreshold` 5, `.failureWindow` 10000, `.openDuration` 30000.
The retried failures are the SDK's standard set (network errors, 429 with `Retry-After`, 502–504).

## Removed keys (Decision 5)

`cache.enabled`, `cache.provider` (the cache is the host's), `retry.retryableErrors` (the SDK's standard set),
`resilience.healthCheck.*` (never had a consumer), `ui.credentialsTemplate` (the manifest's credential fields replace
it), every `rateLimit.perEndpoint.<name>` (duplicated `api.endpoints.<name>.throttle`), and `api.endpoints.seriesImage.*`
(its methods, cover upload and removal, are no contract offer and left with the 3.x wrapper).
