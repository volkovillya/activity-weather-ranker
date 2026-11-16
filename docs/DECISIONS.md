# Decision log

Why the service is built the way it is: what was chosen, what else was considered, and what each choice costs. Product questions that would normally go to a product manager come first and are kept separate from the implementation decisions.

## Assumptions and open product questions

Each item states the question and the assumption taken until it is answered.

1. **What "rank" means.** _Q: best days per activity, or best activity per day?_ Assumed: for each activity, every day gets a 0–100 score and the seven days are ranked (1 = best, ties share a rank). Scores are comparable within one activity, not across activities.
2. **"Next 7 days".** Assumed: today plus six days in the location's own time zone, one score per day from daily aggregates, so rain that falls only at night still counts against the day. _Q: do users need time-of-day windows?_
3. **Ambiguous city names.** _Q: do we need an explicit location picker?_ Assumed: the geocoder's top match wins, the resolved location is always returned, and callers can disambiguate with free text ("Paris, Texas").
4. **"Unavailable" vs "bad".** Assumed: an activity is unavailable only when there is not enough data to judge it (for example no wave data inland); bad weather is a low score, never "unavailable".
5. **Skiing.** Assumed: judged from snow and weather at the town's coordinates, not at a ski resort, so a valley town can score low while its slopes are open. _Q: should towns resolve to nearby resorts?_
6. **Surfing.** Assumed: judged from the offshore wave model near the town, not breaking waves at a beach. Wind direction relative to the coast, tides and water temperature are ignored, and "too big" assumes a recreational surfer.
7. **Indoor sightseeing.** Assumed: always possible; its score means "how good a choice it is that day", so it rises when outdoor conditions are poor. _Q: is that the intent, or should indoor be constant?_
8. **Thresholds and weights** are judgment calls for a recreational user and have not been validated with domain experts.
9. **Several cities in one request.** _Q: do clients need to compare cities in one request?_ Assumed: no. One operation asks for one city, and comparing cities takes several requests. Raising the limit is a one-line change (`MAX_CITIES_PER_OPERATION`).

## Decisions

### Runtime and tooling

- **Node 24, TypeScript in strict mode, CommonJS output.** ESM was considered; CommonJS avoids Jest/ESM configuration friction and costs nothing at this size. `noUncheckedIndexedAccess` is on because most data arrives as arrays from an upstream API.
- **Jest with `@swc/jest`.** `ts-jest` type-checks while testing and is slower; type checking is a separate `npm run typecheck` step instead. Tests import from `@jest/globals`, so Jest's global types do not leak into application code.
- **ESLint with type-aware rules**, because rules such as `no-floating-promises` catch real mistakes in concurrent code. Prettier owns formatting.
- **Exact dependency versions**, so a reviewer installs what was tested.

### Configuration

- **Environment variables are validated with Zod at startup.** One error lists every invalid variable and never echoes values, so a malformed `DATABASE_URL` cannot print its password.
- **Integers must be plain digit strings.** `z.coerce.number()` was rejected because it turns an empty string into `0`: an accidental `FORECAST_TTL_SECONDS=` would silently disable caching. Timeouts must be positive, since 0 means "wait forever" in Postgres and node-postgres.
- **Defaults are judgment values, not measurements:** forecast TTL 1 hour (Open-Meteo's models typically update every 1–6 hours), marine retry window 5 minutes, upstream timeout 3 seconds, database connection and statement timeouts 5 seconds each.
- **Open-Meteo base URLs are configurable**, so tests and outage demos can point the service at a fake or unreachable host without code changes.

### Storage

- **PostgreSQL 17, run locally with Docker Compose.** SQLite was considered: no setup for a reviewer, but the refresh logic depends on concurrent writers and conditional upserts, which Postgres lets the tests exercise for real. The cost is that running the service and its integration tests needs Docker.
- **Three tables.** `locations` (keyed by Open-Meteo's stable geocoding id), `location_lookups` (normalised search text → location) and `daily_forecasts` (one row per location and local date). Raw weather is stored and scores are computed on read, so changing a scoring rule never requires a refetch.
- **Typed columns rather than a JSON blob.** Only the values the scoring reads are stored, each in a nullable `double precision` column named with its unit. The database enforces the shape and returns numbers exactly as received; the cost is a migration whenever a new input is needed.
- **Dates are `date` columns read as `'YYYY-MM-DD'` strings.** Mapping them to JavaScript `Date` objects would shift a day for time zones east of UTC.
- **Drizzle with committed SQL migrations.** `drizzle-kit generate` writes plain SQL into `drizzle/`; `npm run db:migrate` applies it, and the integration tests apply the same files. A heavier ORM was not needed for three tables, and Drizzle's query builder stays close to the SQL it produces, which matters for the conditional upsert below.
- **Connection and statement timeouts are configured and tested.** Every pooled connection gets `statement_timeout`, and opening a connection is bounded by `connectionTimeoutMillis`. Tests show that a long statement is cancelled and that a server which never completes the handshake times out.

### Open-Meteo client (`src/openmeteo/client.ts`)

- **Three functions behind one interface** (`geocode`, `fetchWeather`, `fetchMarine`), created with base URLs, a timeout and an injectable `fetch`, so tests need no HTTP-mocking library.
- **"Not found" is a value; every failure is one error type.** Geocoding returns `{ kind: 'not_found' }` when there is no match. Everything that goes wrong raises `UpstreamError` with the endpoint and the kind of failure (`http`, `network`, `timeout`, `invalid_body`), so callers can tell "this place does not exist" from "Open-Meteo is unavailable".
- **Explicit time zone and dates.** Weather and marine requests send the location's time zone and the exact seven dates, and a response for any other dates is rejected. `timezone=auto` was rejected: if Open-Meteo's idea of "today" differed from the service's, stored dates would never match and every request would refetch.
- **Missing and invalid values are kept apart at the boundary.** JSON `null` is _missing_: it is kept, and the activity that needs it becomes unavailable. A value of the wrong type, a non-finite number (JSON `1e999` parses to `Infinity`) or a value outside a wide physical range for its variable is _invalid_, and the whole response is rejected rather than turned into `null`, because a broken response is not trustworthy for its other values either. The ranges are deliberately generous; snow depth allows up to 100 m because Open-Meteo reported about 20 m on ice sheets when checked.
- **Units are pinned and checked.** Requests name their units and the response's `daily_units` must match exactly, so an upstream change (for example snow depth in centimetres instead of metres) fails loudly instead of skewing scores by a factor of 100.
- **Coordinates are checked before any request.** A NaN, infinite or out-of-range latitude or longitude raises a `RangeError` and nothing is sent; coordinates come from stored locations, so this is a guard against bugs rather than an upstream failure.
- **Each request has its own timeout** (`UPSTREAM_TIMEOUT_MS`); there are no retries.
- **Only the first geocoding result is validated**, since it is the only one used. Its time zone must be one the runtime recognises, because every date calculation depends on it.

### Scoring (`src/domain/`)

- **`score = round(100 × gate × quality)`.** _Gates_ answer "can you do it at all" (snow depth, wave height, a downpour, a gale): 1 in normal conditions, falling to 0 only at extremes; the lowest gate counts. _Quality_ is a weighted mean of factors that answer "how pleasant is it". Two simpler formulas were rejected:
  - A plain weighted mean lets a must-have be outvoted. Without the gate, a cold, calm day with no snow on the ground scores 85 for skiing (the quality of the "no snow" reference example in the tests); with it, the score is 0.
  - `min(weighted mean, limiting factor)` fixes that but flattens the week: whenever the limiting factor is the worst input, the score _is_ that factor. A week with the same 20 cm snow base every day would get seven identical scores. Multiplying keeps the days apart (36, 38, 26, 43, 26, 30, 39 for such a week, pinned in a test).
- **Every input is a piecewise-linear curve** (`interpolate`), so similar days get different scores. Fixed penalty tiers were rejected for the same reason: a week of mild weather would collapse into identical scores.
- **Curves and weights are data, in one table per activity**, each with a comment on why it has that shape. The numbers are judgment calls (assumption 8). Surfing weights swell period above wave height because period largely determines wave quality.
- **Indoor sightseeing is derived from the outdoor score:** `50 + (100 − outdoor) / 2`, capped by strong wind and heavy rain because getting there in a storm is unpleasant (assumption 7). "100 unless dangerous" was rejected because it ties almost every day.
- **Halves round up, deliberately.** `100 × 0.5 × 0.79` evaluates to `39.49999999999999` in floating point, so `Math.round` gives 39 where the arithmetic says 40. `roundScore` adds `1e-9` before rounding. An offline check against exact rational arithmetic (not part of the test suite), over 414 444 inputs at Open-Meteo's precision, found no case where `roundScore` disagreed with exact round-half-up, while plain `Math.round` disagreed in 6 086 cases; the closest true value below a half was 0.0005 away, far outside the `1e-9` window. The tests pin values just below, at and above a half.
- **Availability is all-or-nothing per activity.** An activity is scored only when every input it reads is present on every day; otherwise it is unavailable with a reason (`NO_MARINE_DATA`, `MARINE_TEMPORARILY_UNAVAILABLE`, `INCOMPLETE_DATA`). Missing values are never replaced with 0, which would read as "bad" rather than "unknown". For surfing, the marine-request flag is checked before the values, so data from a failed marine request is never shown as available. Each activity declares the inputs it reads, and a test checks that the declaration matches what the scoring code reads.
- **Reasons** list the limiting gates first ("Limited by snow depth 20 cm"), then each factor's measured value in a fixed order, with up to two decimals — the precision Open-Meteo reports. One decimal was used first and rejected: near a threshold it printed the threshold itself (0.79 m appeared as "Limited by wave height 0.8 m", the height at which that gate is fully open).
- **Scoring keeps one invariant and leaves validation to the boundary.** It refuses `null` and non-finite inputs (which would surface as an internal error) instead of producing a plausible-looking score; type and range checks happen once, in the Open-Meteo client. If an implausible but finite value ever reached scoring, every curve clamps outside its range, so scores would still be integers from 0 to 100.
- **Ranking:** higher score first; equal scores share a rank (1, 1, 3). Days are returned in date order with their rank.
- **Units stay in field names** (`snowDepthM`, `snowfallCm`), because Open-Meteo reports snow depth in metres and snowfall in centimetres. The one conversion happens inside the skiing table.

### Locations (`src/services/locationService.ts`)

- **A known search never geocodes again.** Search text is normalised (Unicode NFC, trimmed, single spaces, lower case), so "Kraków ", "kraków" and "KRAKÓW" share one lookup row, and a stored search keeps working even while the geocoder is down.
- **The stored lookup decides what a search means.** Two first requests for the same text can geocode at the same time, and the geocoder can rank results differently between calls. Both inserts use `ON CONFLICT DO NOTHING`, and each request then reads the lookup back and returns the location it points to, so every caller gets the same place. The cost: a location row inserted by the losing request stays unused.
- **"Not found" and "geocoder unavailable" are different errors.** A miss stores nothing and returns `LOCATION_NOT_FOUND`; a geocoding failure returns `UPSTREAM_UNAVAILABLE`.

### Forecast caching and refresh (`src/services/forecastService.ts`)

- **Refresh on read, with a TTL** (1 hour by default). A scheduled job was rejected: the set of cities is unbounded and unknown, and refreshing on demand costs nothing for cities nobody asks about. The cost is that the first request after expiry waits for Open-Meteo.
- **A week is complete only if each of its seven local dates has a row**, matched by date. After local midnight the week moves on, so a recently refreshed week can still be incomplete; it is refetched rather than served short.
- **Weather freshness and marine retries are separate rules.** Weather is fresh while its oldest row is younger than the TTL. A week stored without marine data because the marine request failed is refreshed again after `MARINE_RETRY_SECONDS`. The retry window can only shorten how long a week is served; it never affects `stale`.
- **`stale` has one meaning:** this request tried to refresh expired weather and failed, so older stored weather was served. It is not a measure of age (`fetchedAt` is) and says nothing about marine data, which is reported per activity. A refresh that succeeds is never stale, even when it takes longer than a very short TTL.
- **Partial weeks are never served.** If a refresh fails and the stored week is incomplete, the request fails with `UPSTREAM_UNAVAILABLE`. The cost: during an Open-Meteo outage that spans local midnight, a city with six stored days gets an error rather than a shorter week.
- **Rows record when their refresh was requested, and an upsert only replaces older rows.** Recording when the refresh _finished_ was considered and rejected: a refresh whose marine call hangs for a few seconds would finish after a newer one and overwrite fresher weather with older data, labelled as the newest. With request time, the refresh requested later wins regardless of which one writes first — by the clock of the instance that sent it.
- **Responses are always read back from Postgres**, never built from the upstream payload. A caller whose write lost to a newer one gets the newer rows; a caller whose refresh failed still benefits if another instance succeeded meanwhile; and data that failed to persist is never returned. A database error is reported as an internal error, not as stale weather.
- **Marine data is best-effort; weather is required.** A failed marine request still stores the weather, so skiing and sightseeing are unaffected while surfing shows "temporarily unavailable". Weather and marine values are replaced as one unit: a refresh requested later replaces the rows even if its marine call failed and an earlier one's succeeded, and surfing then stays unavailable until the retry window passes and a retry succeeds. A refresh waits for the marine call, bounded by the upstream timeout. Fetching marine data in the background, or keeping the previous wave values with their own timestamp, were rejected as a second write path and a second freshness state for little gain.
- **Concurrent requests share one refresh within a process** (single-flight), keyed by location _and_ week, so two requests either side of local midnight do not share a refresh meant for the other week. The entry is removed however the refresh ends, so a failure is never cached. Several instances can refresh the same week at once; that is wasteful, and the guarded upsert keeps the newest request's data. A cross-instance lock was not added.
- **Rows are written in date order**, so overlapping upserts take row locks in the same order. This is intended to avoid deadlocks; it has not been load-tested. A deadlock that did occur would surface as an internal error and the next request would retry.

### GraphQL API and HTTP (`src/graphql/`, `src/index.ts`)

- **Apollo Server, schema-first.** The SDL in `schema.ts` is the contract, and a test compares it type by type and field by field with a reference copy. No type refers back to itself, so query depth is bounded without a depth-limit plugin.
- **One thin resolver:** validate the input, resolve the location, load the week, rank the activities. The behaviour lives in the services and the domain, which are tested separately.
- **Input:** `city` is trimmed and must be 1–100 characters, counted as Unicode characters rather than UTF-16 code units (100 emoji are accepted).
- **Errors have fixed wording and a code.** `BAD_USER_INPUT`, `LOCATION_NOT_FOUND`, `UPSTREAM_UNAVAILABLE`, or `INTERNAL_SERVER_ERROR` for anything else. Upstream URLs, HTTP statuses and response text go to the logs, never to the client. `formatError` keeps the message only for an allow-list of client-facing codes (ours plus Apollo's request errors, such as an unknown field); everything else becomes a generic internal error and is logged in full. Errors raised while resolving a query come back with HTTP 200 and an `errors` array; invalid GraphQL and malformed requests get HTTP 4xx.
- **Unsupported operations are validation errors.** The API has queries only. graphql-js 16 rejects a `mutation` or `subscription` only while executing it, with an error that has no code, so it was masked and logged as an internal error. A small validation rule (graphql-js 17 adds an equivalent, `KnownOperationTypesRule`) now rejects them up front as `GRAPHQL_VALIDATION_FAILED`, HTTP 400. The schema is unchanged.
- **HTTP through Apollo's official Express integration** (`@as-integrations/express5`, with `express` and `cors`). Apollo's `startStandaloneServer` was used first and replaced: errors raised before GraphQL runs — a malformed JSON body, an unsupported charset, an oversized body — went to a default error handler that, outside production, answered with an HTML page containing the stack trace and absolute file paths, with no hook to change that. One small error handler now answers those cases as JSON with fixed wording and logs them. A hand-written HTTP layer was rejected: CORS, preflight, body limits and connection draining are better left to well-established code. The standalone server's behaviour was kept: CORS for any origin, a 50 MB body limit, Apollo's CSRF protection and landing page, and draining connections on shutdown.
- **The GraphQL server is created without HTTP** (`createGraphQLServer`) so tests can call it directly; `startHttpServer` serves it, and `index.ts` wires configuration, the database, the client and the services together and shuts down on SIGINT/SIGTERM.
- **Structured logs with pino:** geocoding hits and calls, cache hits and misses, refreshes with their duration, upstream failures, rejected HTTP requests and masked internal errors.
- **`npm run dev` runs `tsx watch src/index.ts`**; `tsx` is a development dependency only. There is no build or start script because deployment is out of scope. A local `.env` is loaded at startup when present.

### Testing and CI

- **Two Jest projects.** `unit` (`npm test`) needs no network or database; `integration` (`npm run test:integration`) runs against real Postgres, in band, because its tests share one database. That database, `ranker_test`, is dropped, recreated and migrated with the real migration files at the start of every run. With no integration tests present the project fails rather than passing empty.
- **No test calls Open-Meteo.** Six real responses were recorded once and are committed unchanged (Prettier skips them); invalid variants are derived from them in code. Integration tests run the real client against these fixtures through a fake `fetch`, or replace the client with a fake.
- **Concurrency tests control ordering instead of relying on timing.** A fake clock and promises settled by hand fix the interleaving; there are no sleeps. "Several instances" is modelled as two service instances in one process, on one database and one clock. The tests therefore prove the ordering rules and the single-flight behaviour under the interleavings they set up; they do not prove behaviour under clock skew between machines, under load, or that deadlocks cannot occur.
- **Tests were checked against deliberate defects during development.** Key rules (gates, rounding, availability, freshness, the guarded upsert, single-flight, error masking, the HTTP error handler) were broken on purpose in throwaway copies to confirm a test fails. These checks were run by hand and are not part of CI.
- **One GitHub Actions workflow** is configured to run on every push and pull request: `npm ci` from the lockfile, lint, typecheck, unit tests, then integration tests against a PostgreSQL 17 service container, with read-only repository permissions.

### Dependency audit

- **Policy: runtime dependencies should audit clean; advisories in development tooling are reviewed, not force-fixed.** The current development advisories (in glob, minimatch and deepmerge) are reached only through Jest and typescript-eslint, which process this repository's own files, not user input. npm's suggested fix would downgrade Jest to v25, and deepmerge has no patched release. There is one runtime exception, below.

#### Runtime exception: `@graphql-tools/utils`

[GHSA-c4qx-w738-7hr3](https://github.com/advisories/GHSA-c4qx-w738-7hr3) (high): prototype pollution in `mergeIncrementalResult`. This is a vulnerability in a dependency; no exploit against this service has been demonstrated, and the analysis below explains why its preconditions are not met.

- **Dependency path:** `@apollo/server@5.5.2 → @graphql-tools/utils@12.0.1`, also required by `@graphql-tools/schema@10.1.1` and `@graphql-tools/merge@9.2.4` (one deduplicated copy). Affected `>=10.10.1 <=12.0.1`; fixed in 12.0.2.
- **No supported clean version.** Apollo Server 5.5.2, the latest release, declares `utils ^10.9.1 || ^11.0.0 || >=12.0.0 <12.0.2`, `schema <10.1.2` and `merge <9.2.5`. The only versions it allows that avoid this advisory (utils 10.9.1–10.10.0, with schema 10.0.26 and merge 9.1.2) are affected by [GHSA-7mx3-vvmw-hjmv](https://github.com/advisories/GHSA-7mx3-vvmw-hjmv) instead (prototype pollution in `mergeDeep`, `<=12.0.0`), which 12.0.1 fixes. 12.0.1 is therefore the least exposed version Apollo supports. Forcing 12.0.2 or later against Apollo's declared range was rejected.
- **Exploit preconditions, from the advisory:** the application calls `mergeIncrementalResult` on incremental (`@defer`/`@stream`) results received from another GraphQL server or an untrusted transport, without validating their `path` segments, and an attacker controls or intercepts that upstream.
- **Why they are not met here:**
  1. The service consumes no GraphQL upstream; its only outbound requests are REST calls to the configured Open-Meteo base URLs.
  2. It neither produces nor receives incremental results: graphql-js 16 has no `@defer`/`@stream`, and a test checks that both directives are rejected.
  3. Nothing calls the function: across the installed dependency tree, only the package's own index re-exports it, and Apollo uses the package for `makeExecutableSchema`.
  4. A one-off runtime check (not part of CI), with the function wrapped in the module instance Apollo loads, ran the GraphQL integration tests of the time — including HTTP requests and `@defer`/`@stream` attempts — without a single call to it.
- **Reconsider** when Apollo widens its supported range, or if the service ever consumes another GraphQL server or enables incremental delivery; the `@defer`/`@stream` test fails in the latter case.

### Post-review hardening

These entries were added after the six implementation phases, following a review of how the finished service behaves under load and abuse. Each entry went in with its change.

- **One city per operation.**
  - **The risk.** Root query fields resolve concurrently, so one request carrying hundreds of aliased `activityRankings` fields could trigger hundreds of geocoding and forecast calls.
  - **The rule.** A validation rule rejects an operation that requests more than one city before anything runs (`GRAPHQL_VALIDATION_FAILED`, HTTP 400).
  - **How it counts.** It counts distinct response keys and follows fragment spreads and inline fragments. Fields under the same key are merged by GraphQL and resolved once. `@skip` and `@include` are ignored, so the count can only err high.
  - **Why one.** With one city per request, any per-request limit at a gateway maps directly to upstream cost: at most three calls. A limit of five was considered; it would weaken every such limit five-fold for a use case the brief does not mention (assumption 9).
  - **Scope.** The rule covers `activityRankings` only. A data field added to `Query` later would need the same treatment.
- **Request bodies are limited to 100 KB, Express's default.** This reverses the earlier choice to keep the standalone server's 50 MB limit (see "HTTP through Apollo's official Express integration" above).
  - **Why.** A query for this schema is a few kilobytes. A 50 MB body is buffered in memory and parsed synchronously, so a few such requests can block the event loop for every client. A large body was also the only way to fit thousands of aliases into one request.
  - **Error.** A larger body still gets the existing JSON error (`BAD_REQUEST`, HTTP 413).
- **The connection pool size is configurable** (`DB_POOL_MAX`, default 10). The pool used node-postgres's implicit default of 10 connections per process. With several instances, instances × pool size must stay below Postgres's `max_connections` (100 by default), so the value is now explicit. A request that finds the pool full still waits at most `DB_CONNECTION_TIMEOUT_MS`.

## Known limitations

- **Scoring thresholds are unvalidated.** For example, a sunny day at 0 °C scores 68 for outdoor sightseeing, which some would call generous, and indoor scoring 50 on a perfect day is a product opinion. Wind is measured 10 m above the town, not on a ridge or at the beach.
- **One invalid value rejects a whole Open-Meteo response.** That refresh fails, and the service falls back to stored data or reports Open-Meteo as unavailable: one bad day blocks the other six. The physical ranges are judgment values; a genuine record outside them would be rejected.
- **`fetchedAt` is when the service asked, not the age of the forecast.** Open-Meteo's model run may be hours older, and refetching after the TTL can return the same numbers.
- **Ordering across instances trusts their clocks.** Two instances whose clocks disagree by more than the gap between their requests can order those refreshes the wrong way; both refreshes carry near-identical data.
- **The seven rows of a week can come from different refreshes** — around local midnight, or when another instance writes between this request's write and its read. Each row is the newest stored, and `fetchedAt` reports the oldest. A snapshot id per refresh was not added.
- **There is no end-to-end deadline for a request.** Each Open-Meteo request, connection attempt and SQL statement has its own timeout, so a request that makes several of them can take longer than any one timeout; while Open-Meteo is down, a request for an expired city waits for the upstream timeout before falling back.
- **The endpoint is open:** no authentication or rate limiting, and each new city costs upstream requests and stored rows. Introspection and Apollo's landing page (which loads Apollo Sandbox from Apollo's CDN) are on unless `NODE_ENV=production`.

## Cut, with the reason

- **Front end** — out of scope by the brief.
- **Message broker, Kubernetes, infrastructure as code, cloud deployment** — one process and one database meet the brief.
- **A production build, Dockerfile and deployment** — `npm run dev` is enough to run and review the service.
- **Explicit location picker** — free-text disambiguation covers the common case (assumption 3).
- **Ski-resort lookup** — needs a second data source (assumption 5).
- **Surf wind direction, tides, water temperature** — need coastline orientation and other data sources.
- **Hourly or time-of-day scores** — daily granularity is enough to rank days.
- **Scheduled pre-warming of popular cities** — the set of cities is unbounded; refreshing on demand costs nothing for cities nobody asks about.
- **Cross-instance refresh lock** (for example a Postgres advisory lock) — duplicate refreshes are wasteful but safe.
- **Keeping the previous wave data when a marine request fails** — it would need a second freshness timestamp per row; the retry window restores marine data within minutes.
- **A snapshot id per refresh, or the model-run time as the freshness signal** — neither changes what a user sees.
- **Failure cooldown, circuit breaker, retries with backoff** — upstream timeouts already bound each call; more machinery is not justified at this scale.
- **Negative caching of unknown cities** — a repeated typo costs one geocoding call each time.
- **Cleanup of old forecast rows and unused locations** — storage growth is negligible for this exercise.
- **Authentication and rate limiting** — the main operational risk of an open endpoint, recorded as a known limitation instead.
- **Metrics and tracing** — structured logs are enough to see cache hits and upstream calls.
- **GraphQL code generation and contract testing between services** — one query with one consumer; hand-written types are smaller.
