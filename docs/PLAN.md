> **Provenance.** This is implementation plan v5.1 exactly as approved at 16:45 CET on 16 November 2026, twelve minutes before the first code commit ([c3c277b](https://github.com/volkovillya/activity-weather-ranker/commit/c3c277b)). It was extracted verbatim from the original Claude Code session log after implementation had finished; until then it was kept outside the repository, as its own section 14 required. The only changes are three `[redacted]` markers in sections 13 and 14, and two invisible comments that stop the code formatter from reflowing the text. Statements that were superseded during implementation are left as they were; [WORKLOG.md](WORKLOG.md) records how this plan was reached and what changed afterwards.

<!-- prettier-ignore-start -->

# Plan: activity-weather-ranker (take-home) — v5.1

## 1. Context

Take-home for a Senior/Lead Engineer role. Build a backend service (Node.js, TypeScript, GraphQL) that takes a city or town and ranks the next 7 days for skiing, surfing, outdoor sightseeing and indoor sightseeing, using Open-Meteo data that is persisted rather than fetched per request.

The brief grades two things, in this order: (1) how the work was done — decisions, assumptions, PM questions, what was cut and why, unpolished, "not a write-up"; (2) the service plus a short README. It asks for focus over volume and no front end. A 90-minute live walkthrough follows, so every file must be small enough to explain and change on screen.

Repo: `~/activity-weather-ranker` → https://github.com/volkovillya/activity-weather-ranker (public, one initial commit). The company is not named anywhere in the repo.

**This plan is private.** It lives outside the repository and is never committed, in whole or in part. **Plan history (private):** v1 first design → v2 fixed a scoring formula that let a must-have be outvoted, a freshness rule that ignored date coverage, and an invalid primary key → v3 added explicit dates/time zone, a guarded upsert, best-effort marine, and a polar-night divide-by-zero fix → v4 made the 7-day contract strict and "always serve the persisted snapshot" → v5 (this) replaced `min(mean, limiter)` with `gate × quality` after finding it tied whole weeks, made `stale` a precise rule that survives concurrency, keyed single-flight by location **and** week, gave geocoding and marine explicit outcome types, fixed numbers for every scoring curve, and re-estimated the timebox → v5.1 stamps rows with the time a refresh was *requested* instead of when it finished (a slow marine call could let older weather win), separated weather freshness from marine retry in the `stale` rule, made half-way scores round the same in code and on paper, and turned live Open-Meteo checks into smoke tests only.

## 2. Stack

| Area | Choice | Why |
|---|---|---|
| Runtime | Node 24 LTS (`.nvmrc`), TypeScript strict, CommonJS output | Required; CommonJS avoids Jest/ESM friction |
| GraphQL | Apollo Server (standalone), schema-first SDL | Most recognised; dev landing page lets reviewers run queries |
| Storage | PostgreSQL 17 via Docker Compose | Real upsert/concurrency story |
| DB layer | Drizzle + drizzle-kit, `pg` driver | Typed schema, plain SQL migrations we commit |
| Tests | Jest (`@swc/jest`) | Team's tooling |
| Validation | zod at the Open-Meteo boundary and for env | Upstream JSON is untrusted input |
| Logging | pino, used directly | Needed to see cache hits vs upstream calls |
| CI | One GitHub Actions workflow | Cheap; shows the standard |

Runtime dependencies: `@apollo/server`, `graphql`, `drizzle-orm`, `pg`, `zod`, `pino`. Nothing else.

Not added, on purpose: Kafka, Kubernetes, Terraform, AWS, React, DataDog, Pact, DataLoader, GraphQL codegen, custom scalars, Testcontainers, HTTP mocking libraries, a date library, a DI framework, NestJS, a repository layer, a retry/circuit-breaker library.

## 3. Verified Open-Meteo facts (checked live on 2026-11-16)

- **Geocoding "not found" is always HTTP 200 with no `results` key** (unknown name, one character, whitespace, empty). A found place has `id`, `name`, `latitude`, `longitude`, `timezone`; `country` and `admin1` are sometimes absent (92 results sampled). Free text with a region works ("Paris, Texas"); it also matches postal codes ("1234"). "krakow" and "Kraków" → same id.
- Forecast and Marine accept an explicit `timezone` plus `start_date`/`end_date` and return exactly those 7 local dates. An invalid time zone → HTTP 400.
- All needed weather fields exist as **daily** variables, including `snow_depth_max`. No nulls across 8 diverse cities — a sample, not a guarantee.
- **Units differ:** `snow_depth_max` in **metres**, `snowfall_sum` in **centimetres**, wind km/h, sunshine/daylight seconds.
- Polar night returns `daylight_duration = 0`.
- Marine returns HTTP 200 with **all 7 days null** inland (Kraków, La Paz, Zermatt, Bordeaux) and all values present at 10 coastal or enclosed-sea cities (incl. Gdańsk, Baku, Chicago, Odesa). A partial week was never observed.
- Errors are HTTP 400 with `{"error": true, "reason": "…"}`.
- Terms: free tier is non-commercial and rate-limited; data is CC BY 4.0 → attribution in README.

## 4. Assumptions and PM questions (go into docs/DECISIONS.md)

1. **"Rank" meaning.** For each activity, score each day 0–100 and rank the days (1 = best; equal scores share a rank). Scores compare **within** an activity, not across. *PM question: best days per activity, or best activity per day?*
2. **"Next 7 days"** = today plus 6 days in the location's own time zone. **Daily granularity:** one score per day from daily aggregates, so rain only at night still counts. *PM question: time-of-day windows?*
3. **Ambiguous city names.** Open-Meteo's top match wins; the resolved location is always returned; callers disambiguate with free text. *PM question: explicit location picker?*
4. **"Unavailable" means "we lack the data to judge", never "bad".**
5. **Skiing = snow and weather at the town's coordinates**, not at a resort. A valley ski town can score near zero while its slopes are open. *PM question: resolve to nearby resorts?*
6. **Surfing = offshore wave model near the town**, not breaking waves at a beach. Wind direction relative to the coast, tides and water temperature are ignored. "Too big" assumes a recreational surfer.
7. **Indoor sightseeing** is always viable; its score means "how good a choice it is that day". *PM question: is that the intent, or should indoor be constant?*
8. **All thresholds and weights are judgment calls**, not validated with domain experts.

## 5. GraphQL contract

```graphql
enum Activity { SKIING SURFING OUTDOOR_SIGHTSEEING INDOOR_SIGHTSEEING }

enum UnavailableReason {
  NO_MARINE_DATA                  # marine request succeeded, no wave data on any day (inland)
  MARINE_TEMPORARILY_UNAVAILABLE  # marine request failed; retried later
  INCOMPLETE_DATA                 # some input this activity needs is missing on at least one day
}

type Query {
  activityRankings(city: String!): ActivityRankings!
}

type ActivityRankings {
  location: Location!
  fetchedAt: String!        # ISO-8601 UTC; when the service last asked Open-Meteo for the oldest of the seven rows served
  stale: Boolean!           # true only when this request tried to refresh expired weather data and the attempt
                            # failed; it is not a measure of data age (use fetchedAt) and says nothing about marine data
  activities: [ActivityRanking!]!   # always four, in enum order
}

type Location { id: ID! name: String! country: String admin1: String
                latitude: Float! longitude: Float! timezone: String! }

type ActivityRanking {
  activity: Activity!
  available: Boolean!
  unavailableReason: UnavailableReason   # non-null exactly when available is false
  days: [DayScore!]!                     # exactly 7, chronological, when available; [] otherwise
}

type DayScore { date: String! score: Int! rank: Int! reasons: [String!]! }  # date = YYYY-MM-DD, location-local
```

**Availability is all-or-nothing per activity.** An activity is scored only if every input it reads is non-null on all seven days. There are no partial weeks and no per-day gaps. The reason is the first that applies:

1. Surfing and any row has `marine_fetched = false` → `MARINE_TEMPORARILY_UNAVAILABLE`.
2. Surfing and wave height **and** swell period are null on all seven days → `NO_MARINE_DATA`.
3. Otherwise → `INCOMPLETE_DATA` (covers a partly-null marine week and any null weather input).

**A failed marine request is never shown as available.** Rule 1 looks at the flag before any value: if even one of the seven rows was written by a refresh whose marine call failed, surfing is `MARINE_TEMPORARILY_UNAVAILABLE`, whatever wave values the other rows hold. This also covers a week mixed from two refreshes around midnight. The flag is set only from the outcome of the marine call itself, never inferred from the values.

Four unavailable activities is a valid response, not an error.

**Outcomes for one request**

| Situation | Result |
|---|---|
| `city` empty or longer than 100 characters after trim | error `BAD_USER_INPUT` |
| Geocoding succeeds with no results | error `LOCATION_NOT_FOUND` |
| Geocoding fails (HTTP error, timeout, malformed) and the query has no stored lookup | error `UPSTREAM_UNAVAILABLE` |
| Query has a stored lookup | geocoding is not called at all |
| Weather fails; a complete week is stored | data, `stale: true` |
| Weather fails; stored week is incomplete or absent | error `UPSTREAM_UNAVAILABLE` |
| Marine fails, weather succeeds | data, `stale: false`, surfing `MARINE_TEMPORARILY_UNAVAILABLE` |
| Database error, or anything unexpected | error `INTERNAL_SERVER_ERROR`, generic message, details only in logs |

## 6. Data model (3 tables)

- `locations` — `id integer` PK (Open-Meteo geocoding id), `name text`, `country text NULL`, `admin1 text NULL`, `latitude` / `longitude double precision`, `timezone text`.
- `location_lookups` — `query_normalized text` PK (trim, NFC, lower-case, collapse whitespace), `location_id` FK.
- `daily_forecasts` — PK (`location_id`, `date`); `date` is a Postgres `date` read as a **string**; `fetched_at timestamptz NOT NULL`; `marine_fetched boolean NOT NULL`; nullable `double precision`: `temp_max_c`, `precipitation_mm`, `snowfall_cm`, `snow_depth_m`, `wind_speed_max_kmh`, `sunshine_s`, `daylight_s`, `wave_height_max_m`, `swell_period_max_s`.

Every column is read by the API or by a scoring input. `double precision` keeps upstream numbers bit-identical, so scores computed from the database are deterministic. Raw weather is stored; scores are computed on read. Drizzle queries live in the two services — no repository layer.

## 7. Open-Meteo client (`src/openmeteo/client.ts`)

Three functions, each one HTTP GET with `AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)` (default 3000) and a zod schema. Each has an explicit result type; **every failure is one error class, `UpstreamError`** (HTTP non-2xx, network error, timeout, non-JSON body, schema mismatch).

| Function | Success values | Throws `UpstreamError` when |
|---|---|---|
| `geocode(query)` | `{ kind: 'found', location }` · `{ kind: 'not_found' }` (valid body, `results` absent or empty) | request fails; body malformed; first result lacks id/lat/lon/timezone or its time zone is not accepted by `Intl.DateTimeFormat` |
| `fetchWeather(location, dates)` | 7 days, values `number \| null` | request fails; body malformed; returned dates ≠ the 7 requested |
| `fetchMarine(location, dates)` | 7 days, values `number \| null` (all null inland) | same as weather |

Null values are data, not failures. "Not found" is a value, never an exception. URLs are built with `URLSearchParams` from base URLs in config.

## 8. Freshness, refresh and concurrency (`src/services/forecastService.ts`)

### Freshness terms (one meaning each, used everywhere)

Weather freshness and marine availability are two separate questions and are never mixed.

- **`fetched_at` (row):** the app clock at the moment a refresh **sent** its upstream requests (`requestedAt`), read once before either call. One value per refresh, shared by its seven rows. It does not depend on how long the weather or the marine call took.
- **Week:** the seven local dates `today … today+6`. **Complete** = a row exists for each of those dates, matched by date value.
- **Weather age:** `now − oldest fetched_at` among the seven rows.
- **Weather fresh:** the week is complete and weather age `< FORECAST_TTL_SECONDS` (default 3600; strict, so 0 means never fresh).
- **Marine retry due:** at least one row has `marine_fetched = false` and the oldest such row is at least `MARINE_RETRY_SECONDS` old (default 300). It only triggers a refresh; it never affects `stale`.
- **Refresh needed:** not weather fresh, **or** marine retry due.
- **`fetchedAt` (API):** the oldest `fetched_at` among the seven rows served. A client computes the weather age from it.
- **`stale` (API):** `true` exactly when the weather served is not weather fresh **and** this request's attempt to refresh it failed. It is evaluated after the re-read, against the same TTL. A refresh that succeeded is never stale, even when the TTL is shorter than the refresh itself (TTL 0 or 1 s): the rows were just fetched for this request. It says nothing about marine data, which is reported only through `unavailableReason`.
- **Persisted-only:** a response is always built from rows read from Postgres, never from an upstream payload. Rows are never deleted by the service.

| Weather within TTL | Refresh attempted | Weather fetch | Result |
|---|---|---|---|
| yes | no | — | data, `stale: false` |
| yes | yes (marine retry due) | ok | data, `stale: false` |
| yes | yes (marine retry due) | failed | data, `stale: false` — the weather is still within its TTL; surfing stays `MARINE_TEMPORARILY_UNAVAILABLE` |
| no | yes | ok | data, `stale: false` |
| no | yes | failed, complete week stored | data, `stale: true` |
| no | yes | failed, week incomplete | error `UPSTREAM_UNAVAILABLE` |

When a refresh is attempted:

| TTL | Marine retry | Rows | Refresh after |
|---|---|---|---|
| 3600 | 300 | marine fetched | 3600 s |
| 3600 | 300 | marine failed | 300 s |
| 60 | 300 | marine failed | 60 s |
| 0 | 300 | any | every request |

### Algorithm

```
getWeek(location):
  dates = weekDates(today(location.timezone, clock))
  week  = readWeek(location.id, dates)                 # complete week or "incomplete"
  now   = clock.now()
  if weatherFresh(week, now) and not marineRetryDue(week, now) → return { week, stale: false }

  outcome = await singleFlight(`${location.id}:${dates[0]}`, () => refresh(location, dates))
  week    = readWeek(location.id, dates)               # always re-read, whatever the outcome

  if week is incomplete:
      outcome == 'weather_failed' → throw UPSTREAM_UNAVAILABLE
      otherwise                   → throw Error (invariant broken → INTERNAL_SERVER_ERROR)
  return { week, stale: outcome == 'weather_failed' && !weatherFresh(week, clock.now()) }

refresh(location, dates):                              # resolves 'refreshed' | 'weather_failed'
  requestedAt = clock.now()                            # BEFORE the calls; becomes fetched_at
  [weather, marine] = await Promise.allSettled([fetchWeather, fetchMarine])
  a rejection that is not an UpstreamError → rethrow   # a bug, not an outage
  if weather rejected → return 'weather_failed'        # nothing is written, marine result discarded
  rows = 7 rows in ascending date order, fetched_at = requestedAt:
         weather values + (marine fulfilled ? marine values, marine_fetched = true
                                            : nulls,         marine_fetched = false)
  one INSERT … ON CONFLICT (location_id, date) DO UPDATE SET … 
      WHERE daily_forecasts.fetched_at < excluded.fetched_at
  return 'refreshed'
```

Why each piece is the way it is:

- **Re-read after every refresh attempt.** One exit path: whatever happened, serve what Postgres holds. A caller whose own write lost to a newer one still receives the newer rows; a caller whose fetch failed still benefits if another instance succeeded meanwhile (then `stale` is `false`).
- **Guarded upsert, ordered by request time.** Refreshes are ordered by when they were *sent*, not when they finished: the one requested later wins, whichever writes first. Stamping at completion (v5) was wrong. Example: A is sent at 0 s, its weather arrives at 0.2 s but its marine call hangs until 3 s; B is sent at 1 s and finishes at 1.3 s. Stamped at completion, A (3.0) beats B (1.3) and overwrites newer weather and good marine data with older weather and no marine data, labelled as the freshest. Stamped at request time, A (0) loses to B (1) and its write is rejected. Request time also never overstates freshness: the data is at least as new as the moment we asked. One statement, so a week is never half-written. Rows always go in ascending date order so that two overlapping upserts take row locks in the same order; this is a design expectation that makes a deadlock unlikely, not a proven guarantee. If Postgres did abort one statement as a deadlock victim, it would surface as `INTERNAL_SERVER_ERROR` through the existing database-error path and the next request would retry.
- **Database failure after a good upstream response** → the promise rejects → `INTERNAL_SERVER_ERROR`. The payload is discarded; it cannot be returned because responses come only from `readWeek`. A database fault is never reported as stale weather.
- **Waiting for marine (`allSettled`).** A slow marine API does delay skiing and sightseeing — but only on a refresh, never on a cache hit; by at most `UPSTREAM_TIMEOUT_MS` (3 s); and at most once per location per `MARINE_RETRY_SECONDS`, because no marine retry is due inside that window. Rejected: fetching marine in the background (a second write path, a second freshness state, and a response saying "unavailable" while a fetch is in flight) and fetching marine only when the query selects surfing (couples the cache to query shape and adds a third marine state, "never requested").
- **No scheduled job.** The set of cities is unbounded; lazy refresh costs nothing for cities nobody asks about.

### Single-flight

| Aspect | Behaviour |
|---|---|
| Scope | In-process, one `Map<string, Promise<RefreshOutcome>>` owned by the forecast service instance |
| Key | `` `${locationId}:${dates[0]}` `` — location **and** week. Two requests straddling local midnight ask for different weeks and must not share a refresh |
| What is shared | Only `refresh` (upstream calls + upsert). Each caller does its own reads |
| Start | On a miss the promise is created and stored **before any `await`**, so two callers in the same tick cannot both miss |
| Result | Resolves `'refreshed'` or `'weather_failed'` (an expected outcome, not an exception). Rejects only on unexpected errors (database, bug) |
| Cleanup | The entry is removed in `.finally`, on resolve and on reject. Nothing is cached after settlement — Postgres is the cache |
| On failure | Every waiter gets the same outcome and applies the same rules. There is no retry inside and no cooldown: the next request after settlement starts a new attempt |
| Bounds | The map holds only refreshes in progress. Each step is bounded separately — every upstream call by `UPSTREAM_TIMEOUT_MS`, connection acquisition by `connectionTimeoutMillis`, every statement by `statement_timeout` — but **no single end-to-end deadline is enforced** for a refresh, and none is claimed |
| Not covered | Other instances (duplicate fetch is harmless: guarded, idempotent upsert) and geocoding (two first requests may both geocode; inserts use `ON CONFLICT DO NOTHING`) |

### Overlapping refreshes across local midnight

Request A arrives at 23:59:59 on day D and asks for `D … D+6`; request B arrives two seconds later, on D+1, and asks for `D+1 … D+7`. Their single-flight keys differ, so both refresh at once and both write rows `D+1 … D+6`.

- **Each caller gets exactly its own seven dates.** `readWeek` selects by the caller's own date list. After a caller's upsert commits, every one of its seven dates has a row: either the one it inserted, or an existing one that the guard kept because it was newer. Rows are never deleted. So the caller's week is complete whatever the other refresh did, and it contains no date outside its list.
- **Shared rows end up with B's data in either write order,** because B was requested later. If A writes first, B updates them; if B writes first, A's update is rejected by the guard. Row D is A's only; row D+7 is B's only.
- **A's response then mixes two fetches** (row D from A, the rest from B). That is the documented "not one forecast version" limit; `fetchedAt` reports A's time, the oldest.

### Location resolution (`src/services/locationService.ts`)

Normalise the query → lookup row found → return its location (no upstream call). Otherwise `geocode`: `not_found` → `LOCATION_NOT_FOUND`; `UpstreamError` → `UPSTREAM_UNAVAILABLE`; `found` → insert location, then lookup, both `ON CONFLICT DO NOTHING`, then **read the lookup row back by the normalised query and return the location it points to**. No transaction: if interrupted between the two inserts, the next request repeats the geocode and both inserts are no-ops or complete the pair.

**Lookup race.** `ON CONFLICT DO NOTHING` means our insert may have lost. Two first requests for the same text can geocode to *different* places (Open-Meteo's ranking can change between two calls). If each returned what it had just geocoded, the two callers — and every later caller, who reads the persisted lookup — would get different cities for the same query. So the persisted lookup is the single source of truth: the loser returns the winner's location. The location row the loser inserted stays unused (cleanup of unused locations is on the cut list); no extra column, table or lock is added.

### Limits of `fetched_at` (goes into DECISIONS.md and the README)

- **Not the forecast's own age.** It records when we asked, not when Open-Meteo's model ran. The true age of the weather is `now − fetchedAt` plus an unknown model age. Refetching after the TTL may return identical numbers.
- **Weather and marine are replaced as one unit.** A refresh requested later replaces the rows even if its marine call failed and the earlier one's succeeded. Surfing then shows `MARINE_TEMPORARILY_UNAVAILABLE` until the retry window passes. Accepted: it needs two instances racing within seconds, and it heals itself.
- **Not a strict ordering across instances.** The guard compares clocks of different machines; near-simultaneous refreshes can land in either order. Both hold near-identical data.
- **A later request is not proof of newer data.** Upstream caching can hand an older payload to the later request. The guard stops an earlier *request* from winning, not an older *payload*.
- **One timestamp covers weather and marine together.**
- **Seven rows are not guaranteed to come from one forecast version.** The guard is per row; refreshes around local midnight cover different date ranges, and a concurrent refresh can land between our write and our read-back. Each row is the newest we have; `fetchedAt` reports the oldest. No snapshot id is added: mixed rows differ by minutes and it would be a new concept to store, query and explain.

## 9. Scoring (`src/domain/`)

Pure functions, no I/O, no clock. For one day:

`score = round(100 × gate × quality)`

- **quality** = weighted mean of factor scores (weights sum to 1) — *how nice is it*.
- **gate** = the minimum of the activity's gate scores — *can you do it at all*. A gate is 1 across normal conditions and falls to 0 only at extremes.
- Every gate and factor is `interpolate(points, x)`: piecewise-linear through the listed points, clamped to the first/last value outside them. All values are in [0, 1], so the score is always an integer 0–100.
- **Rounding:** halves round up, through one helper `roundScore(x) = Math.round(x + 1e-9)`. The epsilon is needed: 80 cm base, 15 cm fresh, −5 °C, wind 65 km/h is exactly 39.5 on paper, but floating point yields 39.49999999999999 and plain `Math.round` gives 39. On a fine skiing grid plain rounding disagreed with the exact result in 13 693 of 701 631 cases, all of them exact halves. With the helper, code and hand calculation agree.

Why `gate × quality` and not `min(mean, limiter)` (v4): with `min`, whenever the limiter is the worst factor the score *equals* the limiter and every other factor is ignored. A week with a constant 20 cm snow base would score identically on all seven days. Multiplying keeps the days apart (computed for such a week: 36, 38, 26, 43, 26, 30, 39). A plain weighted mean was rejected earlier because a must-have could be outvoted.

### Curves (points are `x → score`)

**Skiing** — inputs: snow depth, snowfall, max temperature, wind.

| Kind | Input | Weight | Points |
|---|---|---|---|
| gate | snow depth (cm) | — | 5 → 0, 40 → 1 |
| gate | wind (km/h) | — | 50 → 1, 80 → 0 |
| factor | fresh snowfall (cm) | 0.30 | 0 → 0.5, 10 → 1 |
| factor | max temperature (°C) | 0.40 | −25 → 0.3, −12 → 1, −1 → 1, 4 → 0.5, 10 → 0.2 |
| factor | wind (km/h) | 0.30 | 15 → 1, 50 → 0.3 |

**Surfing** — inputs: wave height, swell period, wind.

| Kind | Input | Weight | Points |
|---|---|---|---|
| gate | wave height (m) | — | 0.3 → 0, 0.8 → 1, 2.5 → 1, 4.5 → 0 |
| gate | wind (km/h) | — | 40 → 1, 70 → 0 |
| factor | swell period (s) | 0.50 | 5 → 0.2, 12 → 1 |
| factor | wave height (m) | 0.25 | 0.5 → 0.4, 1.2 → 1, 2.0 → 1, 3.5 → 0.4 |
| factor | wind (km/h) | 0.25 | 10 → 1, 40 → 0.3 |

**Outdoor sightseeing** — inputs: max temperature, precipitation, sunshine, daylight, wind.

| Kind | Input | Weight | Points |
|---|---|---|---|
| gate | precipitation (mm) | — | 1 → 1, 10 → 0.6, 30 → 0.2, 60 → 0 |
| gate | max temperature (°C) | — | −20 → 0, −5 → 1, 33 → 1, 42 → 0 |
| gate | wind (km/h) | — | 45 → 1, 80 → 0 |
| factor | max temperature (°C) | 0.50 | −5 → 0.2, 5 → 0.5, 18 → 1, 26 → 1, 33 → 0.4 |
| factor | sunshine share of daylight | 0.30 | 0 → 0.3, 0.7 → 1 (daylight 0 → share 0) |
| factor | wind (km/h) | 0.20 | 15 → 1, 45 → 0.3 |

**Indoor sightseeing** — inputs: those of outdoor. `score = roundScore(travelGate × (50 + (100 − outdoorScore) / 2))`, where `outdoorScore` is the rounded outdoor score shown to the user and `travelGate = min(wind: 60 → 1, 100 → 0.2; precipitation: 30 → 1, 80 → 0.3)`. Range 10–100.

### Expected examples (computed with the curves above; these rows are the test table)

| Activity | Day | gate | quality | Score |
|---|---|---|---|---|
| Skiing | 80 cm base, 15 cm fresh, −5 °C, wind 10 | 1 | 1 | **100** |
| Skiing | 80 cm base, no fresh snow, −3 °C, wind 10 | 1 | 0.85 | **85** |
| Skiing | no snow, otherwise perfect | 0 | 0.85 | **0** |
| Skiing | 20 cm base, 5 cm fresh, 1 °C, wind 25 | 0.429 | 0.785 | **34** |
| Skiing | 100 cm base, no fresh, 9 °C, wind 15 (slush) | 1 | 0.55 | **55** |
| Skiing | 100 cm base, wind 80 (lifts closed) | 0 | 0.79 | **0** |
| Surfing | 1.5 m, 13 s, wind 8 | 1 | 1 | **100** |
| Surfing | 0.2 m (flat) | 0 | 0.736 | **0** |
| Surfing | 1.2 m, 6 s, wind 30 (wind chop) | 1 | 0.54 | **54** |
| Surfing | 3.5 m, 14 s, wind 15 (big) | 0.5 | 0.821 | **41** |
| Surfing | 5 m (too big) | 0 | 0.85 | **0** |
| Outdoor | 22 °C, dry, 80 % sun, wind 8 | 1 | 1 | **100** |
| Outdoor | 16 °C, dry, 5 % sun, wind 12 | 1 | 0.767 | **77** |
| Outdoor | 22 °C, 25 mm rain, no sun, wind 10 | 0.3 | 0.79 | **24** |
| Outdoor | 40 °C, sunny, wind 10 | 0.222 | 0.7 | **16** |
| Outdoor | −15 °C, polar night (daylight 0), wind 20 | 0.333 | 0.367 | **12** |
| Outdoor | 12 °C, 40 mm rain, wind 90 (storm) | 0 | 0.535 | **0** |
| Indoor | perfect outdoor day (outdoor 100) | 1 | — | **50** |
| Indoor | downpour day (outdoor 24) | 1 | — | **88** |
| Indoor | storm day (outdoor 0, wind 90, 40 mm) | 0.4 | — | **40** |

Boundary rows (same test table). "Perfect otherwise" means the first row of that activity with one input changed.

| Activity | Day | gate | quality | Score | What it pins |
|---|---|---|---|---|---|
| Skiing | base 5 cm, perfect otherwise | 0 | 1 | **0** | gate lower knot |
| Skiing | base 22.5 cm, perfect otherwise | 0.5 | 1 | **50** | gate midpoint |
| Skiing | base 40 cm, perfect otherwise | 1 | 1 | **100** | gate upper knot |
| Skiing | wind 50, perfect otherwise | 1 | 0.79 | **79** | wind gate still open, wind factor at its floor |
| Skiing | wind 65, perfect otherwise | 0.5 | 0.79 | **40** | exact half 39.5 rounds up |
| Surfing | 0.3 m, 13 s, wind 8 | 0 | 0.85 | **0** | gate lower knot |
| Surfing | 0.8 m, 13 s, wind 8 | 1 | 0.914 | **91** | gate opens |
| Surfing | 2.5 m, 13 s, wind 8 | 1 | 0.95 | **95** | last fully open height |
| Surfing | 4.5 m, 13 s, wind 8 | 0 | 0.85 | **0** | gate upper knot |
| Outdoor | 1 mm rain, perfect otherwise | 1 | 1 | **100** | rain gate knot |
| Outdoor | 10 mm rain, perfect otherwise | 0.6 | 1 | **60** | rain gate knot |
| Outdoor | −5 °C, perfect otherwise | 1 | 0.6 | **60** | temperature gate knot, factor floor |
| Outdoor | 33 °C, perfect otherwise | 1 | 0.7 | **70** | temperature gate knot |
| Indoor | outdoor 77 (16 °C, dry, 5 % sun, wind 12) | 1 | — | **62** | 61.5 rounds up |

**Evidence.** All 34 rows were computed twice, independently: once in JavaScript with floating point, once in Python with exact fractions and a separately written interpolation. They agree on every row once `roundScore` is used (0 mismatches); with plain `Math.round` the wind-65 row differs (39 vs 40), which is how the rounding defect was found. Separately, 167 384 scores over a coarse grid of extreme inputs (−50 °C, 150 km/h, 200 mm) were all integers 0–100, and more snow never lowered a skiing score.

**Reasons** (deterministic): for each gate below 1, `"Limited by <note>"`; then every factor's note, in table order. Notes state the measured value with its unit, one decimal at most — e.g. `"Limited by snow depth 20 cm"`, `"fresh snowfall 5 cm"`, `"sunshine 80% of daylight"`, `"no daylight"`. Indoor: `"outdoor score 24"` plus any travel-gate note.

**Ranking:** sort the seven days by score descending; equal scores share a rank (1, 1, 3).

**Known weaknesses of this model (stated, not fixed):** numbers are unvalidated; wind is measured at 10 m in town, not on the ridge or the beach; a day at 0 °C in sun scores 68 for sightseeing, which some would call generous; indoor's "50 on a perfect day" is a product opinion.

## 10. Security notes (short section in README)

- Input: `city` trimmed, 1–100 characters, else `BAD_USER_INPUT`.
- Upstream URLs are built with `URLSearchParams` from fixed base URLs in config; user text never forms a host or path.
- SQL is parameterised by Drizzle. Secrets only via env; `.env.example` committed.
- `formatError` returns a generic message for `INTERNAL_SERVER_ERROR` and stack traces are disabled; details go to logs only.
- The schema has no recursive types, so query depth is bounded by design.
- **Known risks, not mitigated:** unauthenticated endpoint; each new city costs upstream calls and rows; unknown cities are not negatively cached; aliases multiply this per request. Auth, rate limiting and negative caching are on the cut list.

## 11. Project layout

```
src/
  index.ts                      bootstrap (config, db pool with timeouts, Apollo standalone)
  config.ts                     env (zod): DATABASE_URL, PORT, FORECAST_TTL_SECONDS,
                                MARINE_RETRY_SECONDS, UPSTREAM_TIMEOUT_MS, three Open-Meteo base URLs
  graphql/{schema.ts,resolvers.ts,errors.ts}
  domain/{types,interpolate,scoreActivity,skiing,surfing,outdoor,indoor,rank,availability,dates}.ts
  openmeteo/client.ts
  db/{schema.ts,client.ts}      Drizzle schema; migrations in /drizzle
  services/{locationService,forecastService}.ts
test/
  unit/         domain, config, Open-Meteo client — no database, no network
  integration/  services and GraphQL against real Postgres (database `ranker_test`, created and
                migrated in Jest global setup; tables truncated before each test; run in band)
  fixtures/openmeteo/*.json     recorded responses
docs/DECISIONS.md               concise technical decision log (the only document besides README)
docker-compose.yml, .nvmrc, .env.example, .github/workflows/ci.yml, README.md
```

Scripts: `npm test` (unit — no Docker needed), `npm run test:integration` (needs Postgres), `npm run lint`, `npm run typecheck`, `npm run db:migrate`, `npm run dev`.

The resolver is ~10 lines: validate → `resolveLocation` → `getWeek` → `rankActivities`. Dependencies (Open-Meteo client, db, clock, `fetch`) are plain function arguments.

Log events (pino): `geocode.lookup_hit`, `geocode.called`, `forecast.cache_hit`, `forecast.refresh` with outcome and duration, `upstream.error`. Manual verification reads these.

## 12. Tests

**Determinism rule:** the suite never touches the network. Scoring tests build days with `makeDay({ …overrides })` over one explicit baseline, so each test states the numbers it depends on. Client tests replay committed JSON fixtures through a fake `fetch`. Service and GraphQL tests use a fake clock and a fake Open-Meteo client. The only real timer is one client test with a 20 ms timeout.

**Ordering rule for concurrency tests:** nothing relies on timing or `sleep`. The fake client hands out *deferred* promises that the test resolves or rejects by hand, and the fake clock moves only when the test moves it. Each fake response carries values that identify which refresh produced it, so a test can tell whose data a row holds. Where two app instances are needed, the test builds two forecast services over the same database.

**Every test below is mandatory** (section 15). Each one is written to fail under a named wrong implementation, stated in brackets.

**Scoring (S)** — written first
- S0 `interpolate`: at a knot, between knots, below the first and above the last point, and on a two-sided curve (surf height gate: 0.55 → 0.5, 3.5 → 0.5, 9 → 0).
- S1 All 34 rows of the two example tables, exact scores, gate and quality to three decimals. [fails for a plain weighted mean, for `min(mean, limiter)`, and for plain `Math.round`]
- S2 Bounds: extreme inputs give an integer 0–100; polar night gives a finite score. [fails without the daylight-zero guard]
- S3 Snow-depth monotonicity with every other input held constant: for each of several fixed (snowfall, temperature, wind) combinations, raising only the depth through 0, 5, 10, 20, 22.5, 40, 80, 200 cm never lowers the skiing score. Separately: a week with a constant 20 cm base and varying other inputs yields the scores 36, 38, 26, 43, 26, 30, 39. [the second part fails for `min(mean, limiter)`]
- S4 Storm day is not the top indoor day; indoor rises as outdoor falls.
- S5 Ranking: ties share a rank (1, 1, 3).
- S6 Availability: null weather input → `INCOMPLETE_DATA` for exactly the activities that read it; all-null marine with `marine_fetched = true` → `NO_MARINE_DATA`; `marine_fetched = false` → `MARINE_TEMPORARILY_UNAVAILABLE`; swell null on one day → `INCOMPLETE_DATA`; an available activity has exactly 7 days and a null reason. Flag before values: a week where every row has wave data but one row has `marine_fetched = false` → surfing is still `MARINE_TEMPORARILY_UNAVAILABLE`, never available. [fails if availability is decided from the values alone]
- S7 Reasons: gates below 1 produce "Limited by …"; order is fixed.

**Dates (D)** — D1 "today" for a zone ahead of UTC; D2 `addDays` across a DST change and a month end.

**Open-Meteo client (C)**
- C1 Geocode found; C2 no `results` key → `not_found`; C3 empty `results` → `not_found`; C4 HTTP 500, malformed JSON, and a result without time zone each → `UpstreamError`.
- C5 Weather parsed with units mapped; C6 marine all-null (inland) is a success; C7 dates differing from those requested → `UpstreamError`; C8 timeout → `UpstreamError`.

**Database (B)** — real Postgres
- B1 The timeouts are really configured, not just written down: a connection taken from the pool answers `SHOW statement_timeout` with the configured value, and the pool was created with the configured `connectionTimeoutMillis`.

**Location service (L)** — real Postgres
- L1 Second resolve of the same query makes no geocode call; L2 "Kraków " and "kraków" share one lookup; L3 `not_found` → `LOCATION_NOT_FOUND`, nothing stored; L4 `UpstreamError` without a lookup → `UPSTREAM_UNAVAILABLE`; L5 two concurrent first requests do not error and store one location.
- L6 **Conflicting resolutions** (deferred geocode): two calls for "springfield" start, both miss the lookup and both wait on geocoding. The first is resolved with location A and completes; the second is then resolved with a different location B. Expect both calls to return A, exactly one lookup row pointing to A, and a third call to return A with no geocode call. [fails if the service returns the location it has just geocoded]

**Forecast service (F)** — real Postgres, fake clock
- F1 Week within the TTL and no marine retry due → no upstream call. F2 TTL expired → one refetch and the stored values are replaced by the new ones. [F2 fails if the guard never updates]
- F3 Local-midnight rollover: a week fetched at 23:50 is read at 00:10 the next day, inside the TTL → refetch. [fails for a TTL-only rule]
- F4 `readWeek` matches dates, not counts: rows for `today … today+5` plus `today+7` → incomplete. [fails for a row-count rule]
- F5 Weather fails, complete week stored, older than the TTL → the stored values, `stale: true`, `fetchedAt` = the old timestamp. F6 Weather fails, six days stored → `UPSTREAM_UNAVAILABLE`. [fails if partial weeks are served] F7 Weather fails, nothing stored → `UPSTREAM_UNAVAILABLE`.
- F8 Marine fails → rows written with `marine_fetched = false`, weather values present, `stale: false`.
- F9 Refresh windows: TTL 3600 / retry 300 with marine failed → no upstream call at +299 s, one at +301 s; TTL 60 / retry 300 → refetch at +61 s; TTL 0 → refetch on every call.
- F10 Inland vs failed marine side by side: a successful all-null marine response gives `marine_fetched = true`, `NO_MARINE_DATA`, no call until the full TTL; a rejected marine call gives `false`, `MARINE_TEMPORARILY_UNAVAILABLE`, a retry after the window. [fails if the two are stored the same way]
- F11 **Ordering with fast weather and slow marine** (two instances): A is requested at t0; its weather resolves at once, its marine stays pending. B is requested at t0 + 1 s and completes. At t0 + 3 s A's marine rejects and A writes. Expect all seven rows to hold B's values with `fetched_at = t0 + 1 s` and `marine_fetched = true`, and A's caller to receive B's rows. [fails if `fetched_at` is taken after `allSettled`: A would be stamped t0 + 3 s and overwrite B]
- F12 Weather fails for this caller while another instance persisted a complete, in-TTL week meanwhile → that week, `stale: false`. [fails if the pre-refresh read is returned]
- F13 Ten calls started while the upstream promise is still pending → the fake has recorded exactly one weather and one marine call *before* it is resolved; all ten then return the same week. [fails without single-flight; cannot pass by accident through the cache, because nothing is stored yet]
- F14 After `'weather_failed'` has settled, the next call makes a new upstream call. [fails if the map entry is not removed]
- F15 Upstream succeeds, the upsert throws → the call rejects, the table holds no row for that week, and the next call (database working) fetches again and succeeds. [fails if payload data is returned or the entry is kept]
- F16 **Across local midnight** (one instance, Europe/Warsaw): A starts at 23:59:59 on D and B at 00:00:01 on D+1, both pending. Expect two weather requests with different date ranges; then, resolving in both orders (B first, and A first): A returns exactly `D … D+6`, B exactly `D+1 … D+7`, rows `D+1 … D+6` hold B's values, row D holds A's, row D+7 holds B's. [fails for a location-only key: B would join A's refresh and find `D+7` missing]
- F17 **Marine retry does not make weather stale:** TTL 3600 / retry 300; week stored at t0 with marine failed; at t0 + 400 s the weather call fails → an upstream attempt is recorded, the response has `stale: false`, `fetchedAt = t0`, surfing `MARINE_TEMPORARILY_UNAVAILABLE`. At t0 + 3700 s with weather still failing → `stale: true`. [the first half fails under v5's rule, which tied `stale` to the marine window]
- F18 **`stale` with very small TTLs:** TTL 0, refresh succeeds → `stale: false`; TTL 0, weather fails with a complete stored week → `stale: true`; TTL 1 s with the fake clock advanced 2 s while the upstream call is pending, refresh succeeds → `stale: false`. [fails if `stale` is derived from the row's age alone]

**GraphQL (G)** — real Postgres, through the executable schema
- G1 Happy path: four activities in enum order, 7 chronological local dates, ranks consistent with scores. G2 Second call makes no upstream call and `fetchedAt` is unchanged. G3 `LOCATION_NOT_FOUND`. G4 `BAD_USER_INPUT` for empty and over-long `city`. G5 A resolver dependency throws `Error("secret detail")` → the response message is generic and does not contain that text.
- Named outcomes, each from a fixture (these replace any live acceptance check): G6 coastal fixture → surfing `available: true` with 7 days. G7 inland fixture → surfing `NO_MARINE_DATA`, `days: []`. G8 polar-night fixture (daylight 0) → a normal response. G9 a location in `Australia/Sydney` with the clock at 2026-11-16T20:00Z → first date `2026-11-17`. G10 weather fails with a stored week past its TTL → `stale: true` in the response. G11 marine fails → `stale: false` and surfing `MARINE_TEMPORARILY_UNAVAILABLE`.

## 13. How the work is shown (the first thing graded)

The public evidence is two things only: an honest commit history and `docs/DECISIONS.md`.

`docs/DECISIONS.md` is a **concise technical decision log**, appended in the same commit as the change it explains. Sections: **Decisions** (what was chosen, the alternatives considered, the trade-off) · **Assumptions and questions for a PM** · **Known limitations** · **Cut / ran out of time**. Each entry is a few lines about the system, written as engineering reasoning.

It does **not** contain: plan versions or review iterations, AI prompts or conversation excerpts, the owner's questions or learning notes, [redacted]. A technical finding from a review is recorded as the decision it led to (for example "gate × quality instead of min(mean, limiter): a constant snow base tied the whole week"), not as a story about the review.

README opens with the timebox and what was prioritised. A short note on AI assistance is planned, but its wording stays undecided until Phase 6 and must be accurate about how AI was actually used (section 19, item 13).

## 14. Execution rules (mandatory)

- **One phase at a time.** Implement only the current phase; never start the next until the owner replies **"GO"**.
- **Questions first.** If the owner asks a question, answer it before doing anything else. Requested changes are implemented and verified inside the current phase.
- **End-of-phase report, in Ukrainian,** after all work has stopped: (1) what exactly was implemented; (2) important files created or modified; (3) key mechanisms and decisions in simple language with practical examples; (4) why this approach fits and which alternatives were rejected; (5) which tests and checks passed or failed, with real output; (6) remaining risks and assumptions; (7) what the next phase will accomplish.
- **Language.** Explanations and phase reviews in Ukrainian. Code, identifiers, comments, commit messages and all project documentation in English.
- **No action before GO.** No commit, no implementation file and no push until the owner gives an explicit GO for the phase.
- **What the public repository may contain:** source code, tests, configuration, `README.md` and `docs/DECISIONS.md`. Nothing else.
- **Never committed or published:** AI conversation transcripts, prompts or chat histories; the owner's personal questions or learning discussions; internal planning drafts or review iterations (including this plan); [redacted] or any private information; temporary notes; Claude-specific session files; the company name.
- **Planning material stays outside the repository.** This plan lives in `~/.claude/plans/`, which is not under the repo. Phase-report explanations are given in the chat only and are never written into the repo. Scratch files go to the session scratchpad, never the working tree.
- **Guards against accidental staging:** the private patterns — `.claude/`, `CLAUDE.md`, `.mcp.json`, `PLAN*.md`, `NOTES*.md`, `notes/`, `*.transcript*` — go into `.git/info/exclude`, which is local to this clone and is itself never committed or pushed. The committed `.gitignore` holds only ordinary project entries (`node_modules/`, `dist/`, `.env`, coverage). Files are staged by explicit path only — never `git add -A`, `git add .` or `git commit -a`.
- **Check before every commit:** list the staged files (`git diff --cached --name-status`), read the staged diff, and search it for private terms ([redacted], "transcript", "prompt", the owner's work e-mail). If anything private or irrelevant is staged, unstage it and report. The check and its result are shown in the phase report.
- **Commit identity:** the global Git identity on this machine is the owner's **work** e-mail. Before the first commit the repo-local identity must be set to the address the owner chooses (the existing commit uses the GitHub no-reply address); this is confirmed with the owner, not assumed.
- **Honest history.** Commits are meaningful, logically scoped and reflect what was actually done, in the order it was done. No fabricated, back-dated, reordered or rewritten history to tell a nicer story; no amend or rebase of earlier commits to that end. Where the plan says "tests first", the failing tests really are committed first — otherwise the commit message does not claim it.
- **No push without explicit permission.** Commits stay local until the owner says to push, each time.
- **Scope.** No abstractions, dependencies or features beyond this plan. Anything new that seems necessary is raised with the owner first and logged.
- **Full validation at the end of every phase, before the report.** Not only the new work: (1) run the whole suite written so far — lint, typecheck, every unit test, and every integration test once Postgres is in use — and show the real output; (2) re-read **all** code in the repo, not just the files touched in this phase; (3) audit it against this plan section by section — GraphQL contract (§5), data model (§6), client outcomes (§7), refresh rules and `stale` (§8), curves, weights and rounding (§9), test list (§12), Git and privacy rules (§14) — and list every deviation, however small. A deviation is either fixed inside the phase or reported to the owner as an open question; it is never left silent, and the plan is not edited to match the code without the owner's approval.
- **Working copy.** The repository is cloned locally at `~/activity-weather-ranker` (origin: the owner's GitHub repo, branch `main`). All work happens in that clone.
- **Tests are not a cut item.** A phase is reported as done only when every test listed for it in section 12 passes. No test is deleted, skipped (`.skip`, `.only`, commented out) or weakened to make a phase pass. If a mandatory test cannot be made to pass, work stops and the phase is reported as failed, with the output.

## 15. Phases

Estimates are implementation time plus the owner's review of the phase report. Each phase ends with its DECISIONS.md entries committed.

| Phase | Build + review | Depends on |
|---|---|---|
| 1 Foundation | 1.5 h + 0.5 h | — |
| 2 Scoring | 3.5 h + 1 h | 1 |
| 3 Open-Meteo client | 2 h + 0.5 h | 1, types from 2 |
| 4 Persistence and refresh | 6 h + 1.5 h | 1–3, Docker running |
| 5 GraphQL API | 3 h + 1 h | 2–4 |
| 6 CI, docs, verification | 2 h + 1 h | 1–5 |
| **Total** | **≈ 18 h + 5.5 h ≈ 22–26 h** | |

That is three to three and a half working days, plus half a day to rehearse the walkthrough. These are estimates, not measurements. Phase 4 is the least certain: its seventeen service tests need a deferred-promise harness and two instances on one database, and it is the first place the Drizzle conditional upsert is proven. The earlier "two days" figure was too low.

**If the work takes longer, the schedule moves, not the tests.** The mandatory set is every test in section 12: S0–S7, D1–D2, C1–C8, B1, L1–L6, F1–F18, G1–G11. The integration and concurrency tests (L5, L6, F3–F6, F11–F18) are the evidence for the claims this plan makes about persistence, and are the last thing to give up, not the first.

### Phase 1 — Foundation and project setup
- Move the session to `~/activity-weather-ranker` (needs the owner's folder approval); ask which branch to use. Use `/opt/homebrew/bin/git` and Node 24 from nvm.
- Before the first commit: confirm the commit identity with the owner and set it for this repo only; add the private guard patterns to `.git/info/exclude` and create an ordinary `.gitignore` (section 14).
- `docs/DECISIONS.md` starts with the decisions already taken that the scaffold embodies (stack choices and their alternatives, assumptions and PM questions, cut list). No plan file is committed.
- `package.json` with the scripts above, `.nvmrc`, `tsconfig.json` (strict), ESLint + Prettier, Jest with `@swc/jest` (unit and integration projects), `docker-compose.yml` (Postgres 17), `.env.example`, `.gitignore`, `src/config.ts` with a unit test (defaults, rejects negative or non-numeric values).
- **Done when:** `npm run lint`, `npm run typecheck`, `npm test` pass on Node 24. Docker is not needed yet.

### Phase 2 — Activity scoring engine and unit tests
- `src/domain/`: `types` (`DailyWeather` with nullable, unit-suffixed fields), `interpolate`, `scoreActivity`, the four activity tables, `availability`, `rank`, and `rankActivities` that turns a week into four `ActivityRanking`s.
- Test-first: failing tests S0–S7 are committed before the implementation.
- **Done when:** S0–S7 pass.

### Phase 3 — Open-Meteo integration and validation
- `src/openmeteo/client.ts` as specified in section 7; fixtures recorded once and committed.
- **Done when:** C1–C8 pass. A live smoke call per endpoint is run and its output shown in the report; it is not a completion criterion.

### Phase 4 — PostgreSQL persistence, caching, refresh and concurrency
- Precondition: Docker Desktop running.
- `src/db/` (schema, generated SQL migration, pool with `connectionTimeoutMillis` and `statement_timeout`), `src/domain/dates.ts`, both services as specified in section 8, Jest global setup for `ranker_test`.
- **Done when:** B1, D1–D2, L1–L6 and F1–F18 pass.
- The marine degradation trade-off stays as documented (weather and marine replaced as one unit; `marine_fetched` flag; retry window). No extra tables, columns or timestamps are added for it without the owner's approval.

### Phase 5 — GraphQL API and integration tests
- `src/graphql/` (schema, resolvers, error mapping, `formatError`), `src/index.ts`.
- **Done when:** G1–G11 pass. The live smoke test of section 17 is run and reported; it is not a completion criterion.

### Phase 6 — CI, documentation, final verification and GitHub readiness
- `.github/workflows/ci.yml` (lint, typecheck, unit and integration tests with a Postgres service).
- `README.md`: timebox and priorities, what it is, how to run, assumptions, limitations (including "Limits of `fetched_at`" and the scoring weaknesses), security notes, Open-Meteo attribution, pointer to DECISIONS.md.
- README wording must match the plan exactly on three points: (1) `stale` is defined as in section 8 — an unsuccessful attempt to refresh expired weather data, not data age, and nothing about marine; (2) the marine degradation trade-off is stated as it is (weather and marine replaced as one unit; a failed marine call shows surfing as temporarily unavailable until the retry window passes); (3) timeouts are described per step, and **no guaranteed end-to-end refresh deadline is claimed**.
- Final pass over DECISIONS.md, a read-through of every file, section 17 in full, and a check that nothing private is in the repo or its history.
- Push only on the owner's instruction; then confirm CI is green.

**If time runs short, cut in this order and log each cut:** the optional outage demos (section 17) → the CI workflow → `README` reduced to how-to-run, assumptions and known limitations. **Never cut:** any test in section 12, the refresh rules of section 8, `docs/DECISIONS.md`. If even that does not fit, the owner decides between a later submission and a smaller feature set; tests are not quietly dropped.

## 16. Cut list (one line each in DECISIONS.md)

Explicit location picker · ski-resort / elevation lookup · surf wind direction, tides, water temperature · hourly / time-of-day scoring · scheduled pre-warm of popular cities · background or selection-driven marine fetch · cross-instance refresh lock (Postgres advisory lock) · failure cooldown / circuit breaker · serving a partial week when stale · snapshot / version id per refresh · model-run time as the freshness signal · keeping older wave data as "stale" per activity · negative caching of unknown cities · single-flight for geocoding · retries/backoff to Open-Meteo · cleanup of past forecast rows and unused locations · GraphQL codegen · Pact contract tests · auth and rate limiting · metrics/tracing · Dockerfile and deployment.

## 17. Verification

**Acceptance is the automated suite, and only that.** Every mandatory outcome — coastal and inland surfing, polar night, a time zone ahead of UTC, not-found, bad input, cache hit, weather outage, marine outage, concurrency — is proven by a deterministic test in section 12 (G6–G11, F5–F17). Nothing below can fail a phase.

1. **Gate:** `docker compose up -d` → `npm run db:migrate` → `npm test` → `npm run test:integration` → `npm run lint && npm run typecheck`. All green.
2. **Live smoke test (informational).** `npm run dev`, then two or three `activityRankings` queries for any real cities. It passes if the service answers with a well-formed response, or with a well-formed `UPSTREAM_UNAVAILABLE` when Open-Meteo is unreachable. It checks that the real API still matches our schemas and that the wiring works end to end. No score, availability or city-specific outcome is expected of it; whatever comes back is pasted into the phase report as an observation.
3. **Optional demos for the walkthrough (first to cut):** repeat a query and show `forecast.cache_hit` in the log; start with the marine base URL unreachable and show surfing `MARINE_TEMPORARILY_UNAVAILABLE` with `stale: false`; start with `FORECAST_TTL_SECONDS=0` and the forecast base URL unreachable and show `stale: true` for a stored city. These illustrate behaviour already proven by F1, F8 and F5.
4. After push: CI is green.

## 18. Traceability

| Requirement or failure scenario | Where it is handled | Proof |
|---|---|---|
| Accept a city or town | `activityRankings(city)`, `locationService` | G1, G4, L1 |
| Rank the next 7 days | `dates`, `rank`, 7-day contract | G1, S5, D1 |
| Four activities | `domain/{skiing,surfing,outdoor,indoor}` | S1, G1 |
| Open-Meteo is the data source | `openmeteo/client` | C1–C8 |
| Persist; do not call the API on every request | `daily_forecasts`, `location_lookups`, freshness rule | F1, G2, L1 |
| A refresh strategy exists and is explainable | section 8 | F2, F3, F9 |
| Node.js, TypeScript, GraphQL; no front end | stack; API only | lint, typecheck, G1 |
| Show how the work was done | `docs/DECISIONS.md`, commit order | reviewed each phase |
| Must-have outvoted (skiing with no snow) | gates | S1 |
| Whole week tied by a constant limiter | `gate × quality` | S3 |
| Divide by zero in polar night | sunshine share guard | S1, S2 |
| Score out of range or non-integer | clamped curves, `round` | S2 |
| Inland city has no wave data | `NO_MARINE_DATA` | S6, C6, F10 |
| Marine API down | `marine_fetched`, retry window | F8, F9, F10 |
| Marine partly missing | `INCOMPLETE_DATA` | S6 |
| Slow marine delays other activities | bounded by timeout and retry window | F9, C8 |
| Weather API down, full week stored | `stale: true` | F5 |
| Weather API down, week incomplete | `UPSTREAM_UNAVAILABLE` | F6, F7 |
| City not found vs geocoding down | `not_found` value vs `UpstreamError` | C2–C4, L3, L4 |
| Six days served as a week after midnight | completeness by date | F3, F4 |
| "Today" computed in the wrong time zone | `dates`, explicit time zone and dates upstream | D1, C7 |
| Old fetch overwrites newer rows | guarded upsert | F11 |
| Slow marine lets older weather win | `fetched_at` = request time, not completion | F11 |
| Marine retry reported as stale weather | separate weather-fresh and marine-retry rules | F17, G11 |
| Half-way score differs between code and paper | `roundScore` | S1 (wind-65 row) |
| Overlapping refreshes across local midnight | key includes the week; read by own dates; ordered row locks | F16 |
| Caller gets rows older than persisted | read-back after refresh | F11, F12 |
| Unpersisted data returned after a DB error | persisted-only responses | F15 |
| Thundering herd on one city | single-flight | F13 |
| Failed refresh blocks a city forever | cleanup in `finally` | F14, F15 |
| Refresh shared across two different weeks | single-flight key includes the week | F16 |
| Concurrent first requests for a new city | `ON CONFLICT DO NOTHING` | L5 |
| Two first requests geocode to different places | lookup read back after insert; persisted lookup wins | L6 |
| Failed marine request shown as available | flag checked before values | S6, F8, G11 |
| Timeouts written down but not configured | pool options | B1 |
| `stale` means different things in different places | one definition in section 8, repeated in the schema and README | F5, F12, F17, F18, G10, G11 |
| Private material reaches the public repo | section 14 rules: explicit staging, `.gitignore` guards, pre-commit check | staged-file check shown in every phase report |
| Internal details leaked in errors | `formatError` | G5 |
| Named outcomes (coastal, inland, polar night, zone ahead of UTC) | fixtures through the GraphQL layer | G6–G9 |
| Tests depend on live weather | determinism rule, fixtures; live calls are smoke only | whole suite runs offline |

## 19. Open decisions and unverified points

Not resolved by this plan — stated so they are not mistaken for settled:

1. **Scoring numbers are unvalidated.** The curves are internally consistent and bounded (checked), but whether 0 °C in sun deserves 68 is a product question.
2. **"Rank" interpretation and indoor semantics** are assumptions awaiting a PM answer.
3. **Deadline fit.** 22–26 hours is three to three and a half working days; whether that fits the five-working-day window depends on when it started and the owner's available hours. The estimate itself is unproven, Phase 4 most of all. Section 15 says what gives way: optional demos, CI and README length — not tests.
4. **Branch and push timing** — asked at the start of Phase 1; commits stay local until the owner says otherwise.
5. **A partly-null marine week has never been observed** (14 locations sampled). The `INCOMPLETE_DATA` rule for it is tested only with a hand-written fixture.
6. **Library details not yet proven in code:** Drizzle's conditional upsert (`setWhere` with `excluded`), Apollo Server's current major on Node 24, and the Jest + SWC setup. Each is confirmed in the phase that first uses it; a mismatch is raised with the owner before working around it.
7. **`UPSTREAM_TIMEOUT_MS = 3000`** is a judgment value; Open-Meteo answered in well under a second in every check, but no latency distribution was measured.
11. **Commit identity — decided by the owner.** Commits in this repo are authored as `Illya_Volkov <volkovillyaol@gmail.com>`, set with repo-local `git config` in Phase 1 before the first commit (the global work identity is left untouched). Before every commit the author line is checked along with the staged files. This address will be publicly visible in the history; that is the owner's choice.
12. **Commit trailer — decided by the owner: omitted.** No `Co-Authored-By` line and no tool attribution in commit messages.
13. **What the repo says about AI — a short note in the README; its exact wording is undecided until Phase 6.** No draft text is fixed now and none is written into the repo before then. Constraints on whatever is eventually written: (a) it must accurately describe how AI was actually used on this project — including how much of the code and design it produced — and must not understate or overstate that; (b) any claim about review ("every line was read", "every decision was the author's") may be made only if it is true by then; (c) it contains no prompts, transcripts, private planning notes or personal discussions, and links to none. In Phase 6 the owner is shown a proposed wording together with a plain account of the actual usage, and decides. Nothing about AI is committed without that approval.
14. **"How you worked" now rests on two artifacts.** With planning material private, the commit history and `docs/DECISIONS.md` are the only public evidence for the first thing the brief grades. That raises the bar for both; it is a consequence of the privacy rules, not a defect.

8. **Ordering by request time is a heuristic.** It assumes a refresh sent later carries data at least as new, and that instance clocks agree to within seconds. Neither is enforced. Within one instance the fake-clock tests prove the rule; across real machines it is argued, not tested.
9. **The concurrency tests prove the logic, not the database under load.** They control ordering with deferred promises on a single connection pool. Lock ordering between two real overlapping statements (the no-deadlock claim) follows from writing rows in date order and is not exercised by a stress test.
10. **The `1e-9` rounding epsilon** makes exact halves round up. A true value within one billionth below a half would also round up; with inputs of at most two decimals this was not seen in 701 631 cases, but it is not proven impossible.

<!-- prettier-ignore-end -->
