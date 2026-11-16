# Decision log

What was decided, what else was considered, and the trade-off. Entries are added in the same commit as the change they explain; the newest are at the bottom of each section.

## Assumptions and open product questions

Questions I would normally settle with a product manager, and the assumption taken for now.

1. **What "rank" means.** _Q: best days per activity, or best activity per day?_ Assumed: for each activity, every day gets a 0–100 score and the days are ranked (1 = best, ties share a rank). Scores compare within one activity, not across activities.
2. **"Next 7 days".** Today plus six days in the location's own time zone, one score per day from daily aggregates. _Q: do users need time-of-day windows?_ Rain that falls only at night still counts against the day.
3. **Ambiguous city names.** _Q: do we need an explicit location picker?_ Assumed: the geocoder's top match wins, the resolved location is always returned, and callers can disambiguate with free text ("Paris, Texas").
4. **"Unavailable" vs "bad".** An activity is unavailable only when we lack the data to judge it (for example no wave data inland). A bad day is a low score, never "unavailable".
5. **Skiing** is judged from snow and weather at the town's coordinates, not at a ski resort, so a valley town can score low while its slopes are open. _Q: should we resolve towns to nearby resorts?_
6. **Surfing** is judged from the offshore wave model near the town, not the breaking waves at a beach. Wind direction relative to the coast, tides and water temperature are ignored; "too big" assumes a recreational surfer.
7. **Indoor sightseeing** is always possible; its score means "how good a choice it is that day", so it rises when outdoor conditions are poor. _Q: is that the intent, or should indoor be constant?_
8. **Thresholds and weights** are judgment calls for a recreational user and have not been validated with domain experts.

## Decisions

### Runtime and tooling

- **Node 24 LTS, TypeScript in strict mode, CommonJS output.** ESM was considered; CommonJS avoids the Jest/ESM configuration friction and costs nothing in a service this size. `noUncheckedIndexedAccess` is on because most data arrives as arrays from an upstream API.
- **Jest with `@swc/jest`.** `ts-jest` was considered; it type-checks during tests and is slower. Type checking is a separate `npm run typecheck` step instead, so tests stay fast. Test files import from `@jest/globals` so Jest types never leak into application code.
- **ESLint with type-aware rules.** Rules such as `no-floating-promises` catch mistakes that matter in concurrent refresh code. Prettier owns formatting; `eslint-config-prettier` keeps the two from conflicting.
- **Two Jest projects.** `unit` is the default `npm test` and needs no network or database. `integration` (`npm run test:integration`) runs against a real Postgres, in band, because its tests share one database. With no integration tests present it fails rather than passing empty.
- **Dependencies are pinned to exact versions** so that a reviewer installs exactly what was tested.
- **One CI workflow** (GitHub Actions) runs on every push and pull request: `npm ci` from the lockfile, lint, typecheck, unit tests, then the integration tests against a Postgres 17 service container — the same commands a reviewer runs locally. It has read-only repository permissions.
- **Audit policy: runtime dependencies must audit clean; advisories in development tooling are reviewed, not force-fixed.** One runtime exception, below. The development advisories (glob, minimatch, deepmerge) are reached only through Jest and typescript-eslint, which process this repository's own files and configuration, never user input. npm's suggested fix would downgrade Jest to v25; deepmerge has no patched release at all.
- **Runtime exception: `@graphql-tools/utils` 12.0.1 — [GHSA-c4qx-w738-7hr3](https://github.com/advisories/GHSA-c4qx-w738-7hr3) (high): prototype pollution in `mergeIncrementalResult`.**
  - _Path:_ `@apollo/server@5.5.2 → @graphql-tools/utils@12.0.1`, also required by `@graphql-tools/schema@10.1.1` and `@graphql-tools/merge@9.2.4` (one deduplicated copy). Affected `>=10.10.1 <=12.0.1`; patched in 12.0.2.
  - _No supported clean version._ Apollo 5.5.2 (the latest release) declares `utils ^10.9.1 || ^11.0.0 || >=12.0.0 <12.0.2`, `schema <10.1.2` and `merge <9.2.5`. The only versions it allows that avoid this advisory (utils 10.9.1–10.10.0, with schema 10.0.26 and merge 9.1.2) are affected by [GHSA-7mx3-vvmw-hjmv](https://github.com/advisories/GHSA-7mx3-vvmw-hjmv) (prototype pollution in `mergeDeep`, `<=12.0.0`), which 12.0.1 fixes. So 12.0.1 is the least exposed version Apollo supports. Forcing 12.0.2+ against Apollo's declared range was rejected.
  - _Exploit preconditions (from the advisory):_ the application calls `mergeIncrementalResult` on incremental `@defer`/`@stream` results received from another GraphQL server or an untrusted transport, without validating their `path` segments, and an attacker controls or intercepts that upstream.
  - _Why this service is not exposed:_ (1) it consumes no GraphQL upstream — its only outbound calls are REST requests to fixed Open-Meteo URLs; (2) it cannot produce or receive incremental results — graphql-js 16 has no `@defer`/`@stream`, and a test pins that both are rejected; (3) nothing calls the function — across the whole installed dependency tree only the package's own index re-exports it; (4) at runtime, with the function wrapped in the very module instance Apollo uses, the full GraphQL integration suite (including real HTTP and `@defer`/`@stream` attempts) made no call to it.
  - _Revisit_ when Apollo widens its range, or if the service ever consumes another GraphQL server or enables incremental delivery (the test above would fail).

### Configuration

- **Environment variables validated with zod at startup**, with one error that lists every invalid variable and never echoes values (a malformed `DATABASE_URL` would otherwise print its password).
- **Integers must be plain digit strings.** `z.coerce.number()` was rejected: it turns an empty string into `0`, so an accidental `FORECAST_TTL_SECONDS=` would silently disable caching.
- **Defaults:** forecast TTL 1 hour (Open-Meteo's models update every 1–6 hours), marine retry window 5 minutes, upstream timeout 3 seconds. All three are judgment values, not measured.
- **Open-Meteo base URLs are configuration**, so tests and outage demos can point the service at a fake or unreachable host without code changes.

### Storage

- **PostgreSQL 17, run locally with Docker Compose.** SQLite was considered: zero setup for a reviewer, but the refresh logic depends on concurrent writers and conditional upserts, which Postgres lets us test for real. The cost is that running the service and its integration tests needs Docker. The Compose credentials are for local development only.
- **Three tables.** `locations` (keyed by Open-Meteo's stable geocoding id), `location_lookups` (normalised search text → location) and `daily_forecasts` (one row per location and local date). No table for scores: raw weather is stored and scores are computed on read, so changing a scoring rule never needs a refetch.
- **Typed columns, not a JSON blob.** Only the values scoring reads are stored, each in a `double precision` column named with its unit, nullable because Open-Meteo can return null. The database enforces the shape, and numbers come back exactly as received.
- **Dates are `date` columns read as `'YYYY-MM-DD'` strings.** Mapping them to JS `Date` objects would shift a day for zones east of UTC.
- **Drizzle with plain SQL migrations.** `drizzle-kit generate` writes SQL files that are committed in `drizzle/`; `npm run db:migrate` applies them, and the integration tests apply the same files to a fresh `ranker_test` database before every run. Drizzle was chosen over a heavier ORM because its queries read like the SQL they produce, which matters for the conditional upsert below.
- **Connection and statement timeouts are configured and tested.** Every pooled connection gets `statement_timeout`, and opening a connection is bounded by `connectionTimeoutMillis`. Tests prove a slow statement is cancelled and a server that never answers the handshake times out. Each timeout bounds one step; there is no single deadline for a whole request.

### Locations (`src/services/locationService.ts`)

- **A known search never geocodes again.** The search text is normalised (Unicode NFC, trimmed, single spaces, lower case), so "Kraków ", "kraków" and "KRAKÓW" share one lookup row.
- **The persisted lookup decides what a search means.** Two first requests for the same text can geocode at the same time, and the geocoder can rank results differently between two calls. Both inserts use `ON CONFLICT DO NOTHING`, and each request then reads the lookup back and returns the location it points to, so every caller — now and later — gets the same place. A location row inserted by the losing request stays unused (cleanup is on the cut list).
- **"Not found" and "geocoder down" are different errors.** A geocoding miss stores nothing and is reported as not found; a geocoding failure is reported as upstream unavailable. A search that is already stored does not need the geocoder at all, even while it is down.

### Forecast caching and refresh (`src/services/forecastService.ts`)

- **Refresh on read, with a TTL** (default 1 hour). A scheduled job was rejected: the set of cities is unbounded and unknown, and refreshing on demand costs nothing for cities nobody asks about.
- **A week is complete only if every one of its seven local dates has a row**, matched by date. After local midnight the week moves on by a day, so a stored week can be recent and still incomplete — it is refetched rather than served short.
- **Weather freshness and marine retries are separate rules.** Weather is fresh while its oldest row is younger than the TTL. A week written without marine data because the marine request failed is retried after `MARINE_RETRY_SECONDS` (default 5 minutes). The retry window only ever shortens freshness; it never changes whether weather counts as stale.
- **`stale` means one thing:** this request tried to refresh expired weather and failed, so older stored weather was served. It is not a measure of age (`fetchedAt` is) and says nothing about marine data, which is reported per activity. A refresh that succeeds is never stale, even with a TTL shorter than the refresh itself.
- **Partial weeks are never served.** If the refresh fails and the stored week is incomplete, the request fails as upstream unavailable.
- **`fetched_at` is the moment the refresh was requested, and an upsert may only replace an older row.** Stamping when the refresh _finished_ was the first design and is wrong: a refresh whose marine call hangs for three seconds would finish after a newer one and overwrite fresher weather with older, labelled as the newest. Ordering by request time means the refresh asked for later always wins, whichever writes first.
- **Responses are always read back from Postgres**, never built from the upstream payload. A caller whose write lost to a newer one gets the newer rows; a caller whose refresh failed still benefits if another instance succeeded meanwhile; and data that failed to persist can never be returned. A database error is reported as an internal error, not as stale weather.
- **Marine data is best-effort.** Weather is required; a failed marine request still stores the weather (with the marine flag off), so skiing and sightseeing are unaffected while surfing shows "temporarily unavailable". The refresh does wait for the marine call, bounded by the upstream timeout and at most once per retry window. Fetching marine in the background was rejected: a second write path and a second freshness state for little gain.
- **Concurrent requests share one refresh** (single-flight, in process), keyed by location _and_ week, so two requests either side of local midnight do not share a refresh meant for a different week. The entry is removed however the refresh ends, so a failure is never cached. Across several instances a duplicate refresh is possible; it is wasteful but correct thanks to the guarded upsert. A cross-instance lock (Postgres advisory lock) is on the cut list.

### Scoring (`src/domain/`)

- **`score = round(100 × gate × quality)`.** _Gates_ answer "can you do it at all" (snow depth, wave height, a downpour, a gale): 1 in normal conditions, falling to 0 only at extremes, and the lowest gate counts. _Quality_ is a weighted mean of factors that answer "how pleasant is it". Two simpler formulas were rejected:
  - A plain weighted mean lets a must-have be outvoted: a perfectly cold, calm day with no snow on the ground would still score about 50 for skiing.
  - `min(weighted mean, limiting factor)` fixes that but collapses days: whenever the limiting factor is the worst one, the score _is_ that factor. A week with the same 20 cm snow base all week would score identically every day, so there is nothing to rank. Multiplying keeps the days apart (36, 38, 26, 43, 26, 30, 39 for such a week).
- **Every input is a piecewise-linear curve** (`interpolate`), so similar days get different scores instead of falling into the same tier. Fixed penalty tiers were rejected for the same reason: a week of mild weather would collapse into identical scores.
- **Curves and weights are data in one table per activity**, each with a comment on why it has that shape. The numbers are judgment calls for a recreational user (assumption 8). Surfing weights swell period above wave height because period decides wave quality.
- **Indoor sightseeing** is derived from the outdoor score: `50 + (100 − outdoor) / 2`, capped by wind and heavy rain because getting there in a storm is not pleasant (assumption 7). A rule of "100 unless dangerous" was rejected: it ties almost every day.
- **Halves round up, deliberately.** `100 × 0.5 × 0.79` evaluates to `39.49999999999999` in floating point, so plain `Math.round` gives 39 where the arithmetic says 40. `roundScore` adds `1e-9` before rounding so code and hand calculation agree. Checked against exact rational arithmetic on a grid of 414 444 inputs at Open-Meteo's precision: `roundScore` matched every case, plain `Math.round` missed 6 086 (all true halves landing just below in floating point), and the closest true value below a half was 0.0005 — far outside the `1e-9` window, so the epsilon never rounds a genuinely lower value up.
- **Availability is all-or-nothing per activity.** An activity is scored only when every input it reads is present on every day; otherwise it is unavailable with a reason (`NO_MARINE_DATA`, `MARINE_TEMPORARILY_UNAVAILABLE`, `INCOMPLETE_DATA`). Missing values are never replaced with 0, which would read as "bad" rather than "unknown". For surfing the marine-request flag is checked before the values, so a failed marine request is never shown as available. Each activity declares the inputs it reads; a test proves the list matches what the scoring code actually reads.
- **Reasons** list the limiting gates first ("Limited by snow depth 20 cm"), then every factor's measured value in a fixed order, so the same day always gets the same explanation. Values are shown with up to two decimals, the precision Open-Meteo reports. One decimal was tried first and rejected: near a threshold it printed the threshold itself, e.g. 0.79 m became "Limited by wave height 0.8 m" although 0.8 m is where that gate is fully open.
- **Scoring keeps one cheap invariant and leaves validation to the boundary.** It refuses null and non-finite values (it throws, which would surface as an internal error) instead of producing a plausible-looking score. Checking types and physical ranges is the Open-Meteo client's job (below), so it is not repeated in every scoring function. If an implausible but finite value ever got through, every curve clamps outside its range, so scores would still be integers from 0 to 100.
- **Ranking:** higher score first; equal scores share a rank (1, 1, 3). Days are returned in date order, each with its rank.
- **Units stay in the field names** (`snowDepthM`, `snowfallCm`): Open-Meteo returns snow depth in metres but snowfall in centimetres. The one conversion (metres to centimetres for snow depth) happens inside the skiing table.

### Open-Meteo client (`src/openmeteo/client.ts`)

- **Three plain functions behind one interface** (`geocode`, `fetchWeather`, `fetchMarine`), created with their base URLs, a timeout and an injectable `fetch`, so tests and outage demos need no HTTP mocking library.
- **"Not found" is a value, every failure is one error type.** Geocoding returns `{ kind: 'not_found' }` when there are no results. Everything that goes wrong returns an `UpstreamError` with the endpoint and the kind of failure (`http`, `network`, `timeout`, `invalid_body`), so callers can tell "this city does not exist" from "Open-Meteo is unavailable".
- **Explicit time zone and dates.** Weather and marine requests send the location's own time zone and the exact seven dates, and a response for any other dates is rejected. `timezone=auto` was rejected: if the server's idea of "today" differed from ours, stored dates would never match and every request would refetch.
- **Missing and invalid values are kept apart at the boundary.** A JSON `null` is _missing_: it is kept and the activity that needs it becomes unavailable. A value of the wrong type, a non-finite number (JSON `1e999` parses to `Infinity`) or a value outside a generous physical range for its variable is _invalid_: the whole response is rejected rather than turned into `null`, because a broken response says nothing reliable about its other values. The ranges are deliberately wide (for example snow depth up to 100 m, because Open-Meteo reports about 20 m on ice sheets).
- **Units are pinned and checked.** Requests name their units, and the response's `daily_units` must match exactly, so an upstream change (snow depth in centimetres instead of metres) fails loudly instead of skewing scores by a factor of 100.
- **Each request has its own timeout** (`UPSTREAM_TIMEOUT_MS`, covering the body as well). There is no overall deadline across several calls and no retry (see the cut list).
- **Geocoding validates only the first result**, the one we use. Its time zone must be one the runtime knows, because every later date calculation depends on it.
- **Tests replay real responses.** Six responses were recorded once and are committed byte-for-byte (excluded from Prettier); invalid variants are derived from them in code, so the fixtures stay genuine.

### GraphQL API (`src/graphql/`, `src/index.ts`)

- **Apollo Server, schema-first.** The SDL in `schema.ts` is the contract; a test compares it, type by type and field by field, with the approved one. No type refers back to itself, so query depth is bounded without a depth-limit plugin.
- **One thin resolver:** validate the input, resolve the location, get the week, rank the activities. All behaviour lives in the services and the domain, which are tested on their own.
- **Input:** `city` is trimmed and must be 1–100 characters, counted as Unicode characters rather than UTF-16 units (100 emoji are accepted).
- **Four error codes, fixed wording.** `BAD_USER_INPUT`, `LOCATION_NOT_FOUND`, `UPSTREAM_UNAVAILABLE` and `INTERNAL_SERVER_ERROR`. Messages for upstream failures never include URLs, HTTP statuses or upstream text; those go to the logs. `formatError` keeps the message only for an allow-list of client-facing codes (ours plus Apollo's own request errors, such as an unknown field); everything else becomes a generic internal error and is logged in full. Stack traces are never returned. Errors use GraphQL's usual HTTP 200 with an `errors` array.
- **Unsupported operations are validation errors.** The API has queries only. graphql-js 16 rejects a `mutation` or `subscription` only while executing it, with an error that carries no code, so `formatError` masked it as an internal error and logged it as one. A small validation rule (the equivalent of graphql-js 17's `KnownOperationTypesRule`) now rejects them up front as `GRAPHQL_VALIDATION_FAILED` with HTTP 400. The schema and contract are unchanged.
- **HTTP through Apollo's official Express integration** (`@as-integrations/express5` with `express` and `cors`). Apollo's `startStandaloneServer` was used first and replaced: errors raised before GraphQL runs — a malformed JSON body, an unsupported charset — went to a default error handler that, outside production, answered with an HTML page containing the stack trace and absolute file paths, and Apollo offers no hook for that path. Now one small error handler answers those cases as JSON with fixed wording (`BAD_REQUEST`, or a generic internal error) and logs them. A hand-written HTTP layer was rejected: CORS, preflight, body limits and draining are better left to well-established code. The standalone server's behaviour is kept: CORS for every origin, a 50 MB body limit, Apollo's CSRF protection and landing page, and draining connections on shutdown.
- **The GraphQL server is created without HTTP** (`createGraphQLServer`), so tests call it directly; `startHttpServer` serves it, and `index.ts` only wires configuration, the database, the client and the services together, listens, and shuts down cleanly on SIGINT/SIGTERM.
- **Structured logs with pino**: geocoding hits and calls, cache hits and misses, refreshes with their duration, upstream failures and masked internal errors.
- **`npm run dev` runs `tsx watch src/index.ts`**; `tsx` is a development dependency only. There is no build or start script because deployment is out of scope. A local `.env` is read at startup when present.

## Known limitations

- **Scoring numbers are unvalidated.** For example, a sunny day at 0 °C scores 68 for outdoor sightseeing, which some would call generous; indoor scoring 50 on a perfect day is a product opinion.
- **Wind is measured 10 m above the town,** not on the ridge or at the beach.
- **One invalid value rejects a whole response.** A single out-of-range number makes that refresh fail, so the service falls back to stored data or reports Open-Meteo as unavailable. That is the intended trade-off — never score from a response known to be broken — but it means one bad day blocks the other six.
- **The physical ranges are judgment values,** wide on purpose; a genuine record-breaking value outside them would be rejected.
- **`fetchedAt` says when we asked, not how old the forecast is.** Open-Meteo's model run may be hours older; refetching after the TTL can return the same numbers.
- **Ordering by request time trusts the instances' clocks.** Two instances whose clocks disagree by more than the gap between their requests can order those refreshes the wrong way. Both carry near-identical data, and skew of seconds is small against a one-hour TTL.
- **The seven rows of a week can come from different refreshes** (around local midnight, or when another instance writes between our write and our read). Each row is the newest we have and `fetchedAt` reports the oldest; a snapshot id per refresh was not added.
- **Weather and marine data are replaced together.** A refresh requested later replaces the rows even if its marine call failed and an earlier one's succeeded; surfing then shows "temporarily unavailable" until the retry window passes.
- **While Open-Meteo is down, each request for an expired city waits for the upstream timeout before falling back.** A failure cooldown is on the cut list.
- **Deadlocks between overlapping refreshes are designed against, not proven impossible.** Rows are always written in date order so concurrent upserts take row locks in the same order; if Postgres still aborted one, it would surface as an internal error and the next request would retry.
- **Introspection and Apollo's landing page are on**, as Apollo enables them outside production, so a reviewer can explore the API in a browser; the landing page loads Apollo Sandbox from Apollo's CDN.
- **There is no end-to-end deadline for a request.** Each upstream call, connection attempt and SQL statement has its own timeout; a request that makes several of them can take longer than any one timeout.

## Cut, with the reason

- **Front end** — out of scope by the brief.
- **Message broker, Kubernetes, infrastructure as code, cloud deployment** — one process and one database answer the brief; anything more is ceremony.
- **Explicit location picker** — free-text disambiguation covers the common case; see assumption 3.
- **Ski-resort lookup** — needs a second data source; see assumption 5.
- **Surf wind direction, tides, water temperature** — need coastline orientation and other data sources.
- **Hourly / time-of-day scores** — daily granularity is enough to rank days.
- **Scheduled pre-warming of popular cities** — the set of cities is unbounded; refreshing on demand costs nothing for cities nobody asks about.
- **Cross-instance refresh lock** — duplicate refreshes from several instances are wasteful but correct.
- **Failure cooldown / circuit breaker, retries with backoff** — upstream timeouts already bound each call; more machinery is not justified at this scale.
- **Negative caching of unknown cities** — a repeated typo costs one geocoding call each time; acceptable here.
- **Cleanup of old forecast rows and unused locations** — storage growth is negligible for this exercise.
- **Authentication and rate limiting** — the main operational risk of an open endpoint, stated as a known limitation instead.
- **Metrics and tracing** — structured logs are enough to see cache hits and upstream calls.
- **GraphQL code generation, contract tests** — one query with one consumer; hand-written types are smaller.
