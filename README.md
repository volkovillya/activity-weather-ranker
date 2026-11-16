# Activity Weather Ranker

A GraphQL service that takes a city or town and ranks the next 7 days for **skiing**, **surfing**, **outdoor sightseeing** and **indoor sightseeing**. Forecasts come from [Open-Meteo](https://open-meteo.com/), are stored in PostgreSQL and are refreshed on demand.

**Stack:** Node.js 24, TypeScript, Apollo Server 5 on Express, PostgreSQL 17 with Drizzle ORM, Zod, Jest, pino.

## How the work was done

- **[docs/PLAN.md](docs/PLAN.md)**: the implementation plan as approved before any code was written.
- **[docs/WORKLOG.md](docs/WORKLOG.md)**: how the work then went, including design reviews, changes of direction, defects found by tests and a later hardening pass, with links to the commits.
- **[docs/DECISIONS.md](docs/DECISIONS.md)**: why it is built this way, covering alternatives, trade-offs, open product questions and what was left out.

## Quick start

Requires Node.js 24 (see `.nvmrc`) and Docker, with port 5432 free.

```bash
cp .env.example .env     # local settings; only DATABASE_URL is required
docker compose up -d     # PostgreSQL 17 on localhost:5432
npm ci
npm run db:migrate       # applies the SQL migrations in drizzle/
npm run dev              # GraphQL API on http://localhost:4000/
```

Opening http://localhost:4000/ in a browser shows Apollo Sandbox (loaded from Apollo's CDN), where you can run this query:

```graphql
{
  activityRankings(city: "Biarritz") {
    location {
      name
      country
      timezone
    }
    fetchedAt
    stale
    activities {
      activity
      available
      unavailableReason
      days {
        date
        score
        rank
        reasons
      }
    }
  }
}
```

The same query from a terminal:

```bash
curl -s http://localhost:4000/ -H 'content-type: application/json' --data '{"query":"{ activityRankings(city: \"Biarritz\") { location { name country timezone } fetchedAt stale activities { activity available unavailableReason days { date score rank reasons } } } }"}'
```

An abbreviated response (values follow the live forecast, so they differ from run to run):

```json
{
  "data": {
    "activityRankings": {
      "location": { "name": "Biarritz", "country": "France", "timezone": "Europe/Paris" },
      "fetchedAt": "2026-11-16T17:27:45.168Z",
      "stale": false,
      "activities": [
        {
          "activity": "SURFING",
          "available": true,
          "unavailableReason": null,
          "days": [
            {
              "date": "2026-11-16",
              "score": 66,
              "rank": 1,
              "reasons": ["swell period 8.3 s", "wave height 2.4 m", "wind 25.8 km/h"]
            }
          ]
        }
      ]
    }
  }
}
```

## Tests and checks

```bash
npm test                   # unit tests: no network, no database
npm run test:integration   # services and GraphQL against PostgreSQL (needs the Docker database)
npm run lint               # ESLint and Prettier
npm run typecheck          # tsc --noEmit
```

- Unit tests cover the scoring, ranking and availability rules, date handling, configuration and the Open-Meteo client.
- Integration tests use a database named `ranker_test` on the same server: it is **dropped and recreated** at the start of every run, then migrated with the files in `drizzle/`.
- No test calls Open-Meteo. The client is tested against real responses recorded in `test/fixtures/openmeteo/`.
- A GitHub Actions workflow (`.github/workflows/ci.yml`) is set up to run all four commands on every push and pull request, with a PostgreSQL service container.

After changing `src/db/schema.ts`, `npm run db:generate` writes a new migration.

## The API

There is one query, `activityRankings(city: String!)`; the schema is in [`src/graphql/schema.ts`](src/graphql/schema.ts). An operation may request one city: asking for a second one (`activityRankings` under another alias, including inside a fragment) is rejected before anything runs. Compare cities with separate requests.

- **`location`** is the place the search resolved to: Open-Meteo's top geocoding match. Adding a region disambiguates, e.g. `"Paris, Texas"`.
- **`activities`** always lists the four activities in the same order. When an activity is available, `days` holds seven local dates (today in the location's time zone, then the next six), each with a `score` from 0 to 100, a `rank` among the seven days (1 = best, equal scores share a rank) and `reasons` describing the measured conditions.
- **`available: false`** means the activity cannot be judged, not that the weather is bad. `unavailableReason` is `NO_MARINE_DATA` (no wave data, e.g. inland), `MARINE_TEMPORARILY_UNAVAILABLE` (the marine request failed and will be retried) or `INCOMPLETE_DATA` (an input is missing on at least one day). `days` is then empty.
- **`fetchedAt`** is when Open-Meteo was last asked for the oldest of the seven days served.
- **`stale`** is `true` only when this request tried to refresh expired weather data and the attempt failed, so previously stored weather was served. A refresh refused because the process is already running its maximum number of upstream operations counts as a failed attempt. `stale` is not a measure of age (use `fetchedAt`) and says nothing about marine data.

Errors have a code in `extensions.code`:

| Code                                          | When                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `BAD_USER_INPUT`                              | `city` is empty or longer than 100 characters                                                                                  |
| `LOCATION_NOT_FOUND`                          | the geocoder has no match                                                                                                      |
| `UPSTREAM_UNAVAILABLE`                        | Open-Meteo cannot be reached, or the upstream limit is reached, and nothing usable is stored                                   |
| `INTERNAL_SERVER_ERROR`                       | anything unexpected; generic message, details only in the logs                                                                 |
| `GRAPHQL_VALIDATION_FAILED`, `BAD_REQUEST`, … | invalid GraphQL (including more than one city per operation) or malformed HTTP requests, such as a body over 100 KB (HTTP 4xx) |

## How it works

```
GraphQL resolver ─► location service ─► forecast service ─► scoring and ranking (pure functions)
                         │                     │
                         └──── PostgreSQL ─────┤
                                               └──► Open-Meteo client (geocoding, forecast, marine)
```

- **Locations.** Search text is normalised (case, whitespace, Unicode) and looked up in Postgres. Only a search not seen before calls Open-Meteo's geocoder, and its result is stored, so the same text keeps resolving to the same place.
- **Caching and freshness.** Raw daily weather is stored per location and local date. A week is served from Postgres when all seven dates are stored and the weather is younger than the TTL (`FORECAST_TTL_SECONDS`, 1 hour by default). Otherwise the service fetches weather and marine forecasts for exactly those dates, writes them in a single upsert and returns what Postgres then holds. Concurrent requests for the same location and week within one process share a single refresh.
- **Failures.** If a refresh fails, a complete stored week is served with `stale: true`; an incomplete week is never served, and the request fails with `UPSTREAM_UNAVAILABLE`. If only the marine request fails, the weather is still stored and served, and surfing is `MARINE_TEMPORARILY_UNAVAILABLE` until a retry after `MARINE_RETRY_SECONDS` (5 minutes by default) succeeds.
- **Upstream limit.** Each process runs at most `UPSTREAM_MAX_CONCURRENT` upstream operations at once (10 by default). A geocode counts as one, and so does a refresh with its weather and marine calls together; requests that join a refresh already running take nothing extra. When the limit is reached the request does not wait: a refresh is skipped and handled like a failed one (a complete stored week is served, with `stale` as above, otherwise `UPSTREAM_UNAVAILABLE`), and a new search gets `UPSTREAM_UNAVAILABLE`. Nothing is written in either case.
- **Concurrent refreshes.** Each row records when its refresh was requested, and an upsert only replaces older rows, so a slow refresh that finishes last cannot overwrite data from a refresh requested after it. Across several instances this ordering relies on their clocks agreeing.
- **Scoring.** Scores are computed on read: `score = round(100 × gate × quality)`. Gates decide whether an activity is possible at all (enough snow, rideable waves, no downpour or gale); quality is a weighted mean of how pleasant the conditions are. Each input is a piecewise-linear curve, defined in one table per activity in [`src/domain/`](src/domain/). The seven days are then ranked within each activity.

## Assumptions

The brief leaves several product questions open; each is listed with the assumption taken in [docs/DECISIONS.md](docs/DECISIONS.md#assumptions-and-open-product-questions). The ones that shape the results most: days are ranked within each activity, not across activities; days are local to the location and scored from daily aggregates; skiing and surfing are judged at the town's coordinates rather than at a ski resort or a particular beach; and all thresholds are judgment calls for a recreational user.

## Limitations

The main ones are below; the full list, with reasons, is in [docs/DECISIONS.md](docs/DECISIONS.md#known-limitations).

- Scoring thresholds and weights are unvalidated judgment calls.
- `fetchedAt` is when the service asked Open-Meteo, not the age of the underlying model run.
- The upstream limit bounds concurrent work in one process. It is not a rate limit and does not keep several instances within Open-Meteo's request quota.
- Timeouts bound each step — every Open-Meteo request, database connection attempt and SQL statement — but there is no overall deadline for a request.
- One out-of-range or non-numeric value rejects a whole Open-Meteo response; missing values (`null`) are accepted.
- A high-severity advisory in a transitive dependency (`@graphql-tools/utils`, via Apollo Server) cannot be fixed within the versions Apollo supports; its exploit preconditions are not met by this service ([analysis](docs/DECISIONS.md#runtime-exception-graphql-toolsutils)).
- Not production-ready: there is no deployment setup or metrics, and the endpoint is open (see Security notes).

## Security notes

- `city` is trimmed and limited to 1–100 characters.
- User input only ever becomes a query parameter of requests to the configured Open-Meteo base URLs; it never forms a host or path. Responses are validated before use.
- SQL is parameterised by Drizzle. Configuration comes from environment variables; `.env.example` contains local development values only.
- Error responses are designed not to reveal internals: unexpected errors return a generic message and are logged in full, and malformed HTTP requests get a JSON error instead of a stack trace. Tests cover these paths.
- Query depth is bounded because no schema type refers back to itself, and query breadth because an operation may request one city, so one request costs at most three Open-Meteo calls. Request bodies are limited to 100 KB. Apollo's CSRF protection is on and operation batching is off.
- Introspection and Apollo's landing page are enabled unless `NODE_ENV=production`.
- The endpoint is unauthenticated and not rate-limited, and each new city costs upstream requests and stored rows. Concurrent upstream work per process is capped (see How it works); a per-client rate limit belongs in front of the service, for example at a gateway.

## Configuration

| Variable                                                     | Default                 | Meaning                                                                                |
| ------------------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                               | — (required)            | PostgreSQL connection string                                                           |
| `PORT`                                                       | `4000`                  | HTTP port                                                                              |
| `FORECAST_TTL_SECONDS`                                       | `3600`                  | How long stored weather is served before a refresh                                     |
| `MARINE_RETRY_SECONDS`                                       | `300`                   | How soon a failed marine request is retried                                            |
| `UPSTREAM_TIMEOUT_MS`                                        | `3000`                  | Timeout for each Open-Meteo request                                                    |
| `UPSTREAM_MAX_CONCURRENT`                                    | `10`                    | Upstream operations at once per process; beyond it, requests fall back without waiting |
| `DB_CONNECTION_TIMEOUT_MS`                                   | `5000`                  | Timeout for opening a database connection                                              |
| `DB_STATEMENT_TIMEOUT_MS`                                    | `5000`                  | PostgreSQL `statement_timeout` for every query                                         |
| `DB_POOL_MAX`                                                | `10`                    | Database connections per process; keep instances × this below `max_connections`        |
| `GEOCODING_BASE_URL`, `FORECAST_BASE_URL`, `MARINE_BASE_URL` | Open-Meteo's public API | Upstream base URLs, e.g. to point tests or demos elsewhere                             |

## Project layout

```
src/
  config.ts             environment variables, validated with Zod
  domain/               scoring, availability, ranking and date logic (pure functions)
  openmeteo/client.ts   Open-Meteo requests and response validation
  db/                   Drizzle schema and connection pool
  services/             location lookup, forecast caching and refresh, upstream limiter
  graphql/              schema, resolver, error handling, Express HTTP server
  index.ts              wiring and startup
drizzle/                SQL migrations
test/unit/              unit tests
test/integration/       PostgreSQL-backed tests with a fake Open-Meteo
docs/PLAN.md            implementation plan, as approved before coding
docs/WORKLOG.md         how the work went, with links to commits
docs/DECISIONS.md       decision log
```

## Data

Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Open-Meteo's free API is for non-commercial use and is rate-limited.

## AI assistance

This project was built with AI assistance. Claude Code helped plan the work and wrote most of the implementation, tests and documentation; a second AI assistant was used for background research. I defined the scope and constraints, evaluated the alternatives, asked for repeated reviews and corrections, and approved the technical decisions recorded in [docs/DECISIONS.md](docs/DECISIONS.md).
