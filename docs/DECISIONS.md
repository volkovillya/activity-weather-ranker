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
- **Audit policy: runtime dependencies must audit clean; advisories in development tooling are reviewed, not force-fixed.** At the time of writing, `npm audit --omit=dev` reports nothing. The remaining advisories (glob, minimatch, deepmerge) are reached only through Jest and typescript-eslint, which process this repository's own files and configuration, never user input. npm's suggested fix would downgrade Jest to v25; deepmerge has no patched release at all.

### Configuration

- **Environment variables validated with zod at startup**, with one error that lists every invalid variable and never echoes values (a malformed `DATABASE_URL` would otherwise print its password).
- **Integers must be plain digit strings.** `z.coerce.number()` was rejected: it turns an empty string into `0`, so an accidental `FORECAST_TTL_SECONDS=` would silently disable caching.
- **Defaults:** forecast TTL 1 hour (Open-Meteo's models update every 1–6 hours), marine retry window 5 minutes, upstream timeout 3 seconds. All three are judgment values, not measured.
- **Open-Meteo base URLs are configuration**, so tests and outage demos can point the service at a fake or unreachable host without code changes.

### Storage

- **PostgreSQL 17, run locally with Docker Compose.** SQLite was considered: zero setup for a reviewer, but the refresh logic depends on concurrent writers and conditional upserts, which Postgres lets us test for real. The cost is that running the service and its integration tests needs Docker. The Compose credentials are for local development only.

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

## Known limitations

- **Scoring numbers are unvalidated.** For example, a sunny day at 0 °C scores 68 for outdoor sightseeing, which some would call generous; indoor scoring 50 on a perfect day is a product opinion.
- **Wind is measured 10 m above the town,** not on the ridge or at the beach.
- **One invalid value rejects a whole response.** A single out-of-range number makes that refresh fail, so the service falls back to stored data or reports Open-Meteo as unavailable. That is the intended trade-off — never score from a response known to be broken — but it means one bad day blocks the other six.
- **The physical ranges are judgment values,** wide on purpose; a genuine record-breaking value outside them would be rejected.

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
