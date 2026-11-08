# manga-list-mangaupdates

[![tests](https://github.com/dcostaz/manga-list-mangaupdates/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/dcostaz/manga-list-mangaupdates/actions/workflows/tests.yml)
[![release-runtime-zip](https://github.com/dcostaz/manga-list-mangaupdates/actions/workflows/release-runtime-zip.yml/badge.svg?branch=main)](https://github.com/dcostaz/manga-list-mangaupdates/actions/workflows/release-runtime-zip.yml)
[![download-runtime-zip](https://img.shields.io/badge/download-runtime_zip-0969da?logo=github)](https://github.com/dcostaz/manga-list-mangaupdates/releases/download/runtime-latest/manga-list-mangaupdates-runtime.zip)

The manga-list tracker plugin for [MangaUpdates](https://www.mangaupdates.com), the manga release and series database
with per-user reading lists. Contract **4.0.0** (`docs/plugins/host-capability-contract.md` in the host repo), built on
`@manga-list/plugin-sdk` in the template's shape (`Plan-2026Q4-tracker-plugin-standardization.md`, Phase 4).

Settings reference: [docs/settings.md](docs/settings.md). What happened to each 3.x method:
[docs/nothing-lost.md](docs/nothing-lost.md).

## Shape

```
src/runtime/apiwrappers/reg-mangaupdates/
  client-mangaupdates.cjs    L4: api.mangaupdates.com — the session login, the endpoints, the lists and their pages, the HTML-edge normalizer
  mapping-mangaupdates.cjs   L3b: pure — MangaUpdates' shapes → the contract's DTOs
  plugin-mangaupdates.cjs    L3a: the template's generic definition (bindings by convention)
  plugin-package.json        the manifest
  mangaupdates-api-settings.{definition,values}.json
  images/mangaupdates-icon.svg
```

## What MangaUpdates is, as this plugin relies on it

From MangaUpdates' API v1 (`https://api.mangaupdates.com/openapi.yaml`) and the live checks recorded by the 3.x
wrapper (2026-07-23, 2026-11-07):

- **Authentication** is a session: `PUT /v1/account/login` with the account's username and password answers a
  `session_token`, sent as `Authorization: Bearer`. It lives 12 hours (`cache.ttl.sessionToken`); the plugin keeps it in
  memory per credential slot, never in the host's cache, and a `401` logs in again once and replays once. Search and
  series reads are made signed in too (`searchOptions.requiresCredential: true`, as the 3.x `searchRequiresAuth`).
- **Lists.** Every account has typed lists — `read`, `wish`, `complete`, `unfinished`, `hold` — and may make custom
  ones, each of which carries one of those types. The status token this plugin speaks is the list's **type**; the list's
  per-account `list_id` travels as `listId`. The manifest's two tables:

  | Host status | push → | ← pull |
  |---|---|---|
  | READING | `read` | `read` |
  | COMPLETED | `complete` | `complete` |
  | PLAN_TO_READ | `wish` | `wish` |
  | ON_HOLD | `hold` | `hold` |
  | DROPPED | `unfinished` | `unfinished` |
  | RE_READING | — (no list type) | — |

  The 3.x manifest's `reading` and `dropped` were never MangaUpdates tokens; they are corrected here.
- **Custom lists.** `statusMapping.<STATUS>` (settings) is an optional host status → `list_id` override, empty by
  default. The host resolves it (contract §2.2): on push it sends the `list_id`, and `subscribe()` takes either a list
  type or a numeric list id; on pull it matches `listId` against the override before the type. RE_READING syncs only
  when its override names a list.
- **Reading a list** is `POST /v1/lists/{list_id}/search` `{ page, perpage }`, paged until `total_hits`. The rating rides
  on each row (`metadata.user_rating`); for one series it is `GET /v1/series/{id}/rating` (404 when unrated).
- **Writes**: add `POST /v1/lists/series`, move or update `POST /v1/lists/series/update`, remove `POST
  /v1/lists/series/delete` with an array of series ids (live-confirmed 2026-11-07: the old `DELETE /lists/{list}/series/{series}` answered 405). A refused
  write answers 200 with `{ status: 'exception' }`, in any case. The chapter is an integer (fractional chapters are sent
  truncated: the manifest declares `scale: integer`); rating 0 clears the rating (`DELETE`).
- **Caching** (the host's cache, keyed by the call's scope): the list-of-lists, each list's contents (a write clears the
  lists it touched), series detail, searches (with their fetch time; `refresh` asks again) and cover bytes. A series'
  list membership is always asked fresh.
- **watch.summary** answers from each series' own record (status text, latest chapter, last update), one lookup per
  entry: never from the user's lists (Decision 3).

## Build and test

```bash
npm test                    # client, mapping, build, and the contract suite (fixture: tests/fixtures/mangaupdates-source.cjs)
npm run typecheck           # tsc --noEmit against the SDK's types
npm run check:nothing-lost  # every 3.x public method classified (docs/nothing-lost.md)
npm run build               # dist/manga-list-mangaupdates-runtime-<version>.zip
```

The zip holds the three files, the manifest (at the root and beside the module), the merged settings and the icon;
never the SDK, which the host places beside the plugin runtime root.

Live checks, by hand, never in CI (`tests/integration/live.manual.cjs`, read-only; both need an account, since search
is authenticated):

```bash
ENABLE_REAL_SEARCH_TEST=1 MU_TEST_USERNAME=... MU_TEST_PASSWORD=... [MU_TEST_SEARCH_QUERY="..."] npm run test:integration
ENABLE_REAL_LIBRARY_TEST=1 MU_TEST_USERNAME=... MU_TEST_PASSWORD=... npm run test:integration
```

`@manga-list/plugin-sdk` is a devDependency on `file:../manga-list-plugin-sdk` (with `install-links=true`) until the
SDK repository has a remote; the GitHub workflows cannot install it until then.
