# Activity Weather Ranker

A GraphQL service that takes a city or town and ranks the next 7 days for **skiing**, **surfing**, **outdoor sightseeing** and **indoor sightseeing**, using [Open-Meteo](https://open-meteo.com/) forecasts that are stored in PostgreSQL and refreshed on demand.

Node.js 24 · TypeScript · Apollo Server (GraphQL) · PostgreSQL 17 (Drizzle) · Jest

**What was prioritised:** correct and explainable rankings, a persistence and refresh model that stays correct under concurrent requests and upstream failures, and tests that prove both. Everything left out on purpose, with the reason, is in [docs/DECISIONS.md](docs/DECISIONS.md#cut-with-the-reason).

The reasoning behind every decision — alternatives considered, trade-offs, open product questions — is in **[docs/DECISIONS.md](docs/DECISIONS.md)**.

## Run it

Requires Node.js 24 (see `.nvmrc`) and Docker.

```bash
cp .env.example .env     # local defaults; only DATABASE_URL is required
docker compose up -d     # PostgreSQL 17 on localhost:5432
npm ci
npm run db:migrate
npm run dev              # http://localhost:4000/
```

Open http://localhost:4000/ in a browser for Apollo Sandbox, or:

```bash
curl -s http://localhost:4000/ -H 'content-type: application/json' --data '{"query":"{ activityRankings(city: \"Biarritz\") { location { name country timezone } fetchedAt stale activities { activity available unavailableReason days { date score rank reasons } } } }"}'
```

Abbreviated response:

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

### Tests

```bash
npm test                  # unit tests: scoring, dates, config, Open-Meteo client — no network, no database
npm run test:integration  # services and GraphQL against real Postgres (Docker must be running)
npm run lint && npm run typecheck
```

The integration tests create and migrate their own `ranker_test` database. No test calls Open-Meteo: the client tests replay real responses recorded in `test/fixtures/openmeteo/`. CI runs all of the above on every push.

## The API

One query: `activityRankings(city: String!)`. The full schema is in [`src/graphql/schema.ts`](src/graphql/schema.ts).

- **`location`** — the place the search resolved to. The geocoder's top match wins; a region in the text disambiguates (`"Paris, Texas"`).
- **`activities`** — always the four activities, in the same order. For each, `days` holds the seven local dates (today in the location's time zone, then six more) with a `score` from 0 to 100, a `rank` (1 = best; equal scores share a rank) and `reasons` explaining the score.
- **`available: false`** means the activity cannot be judged, never that the weather is bad: `NO_MARINE_DATA` (no wave data inland), `MARINE_TEMPORARILY_UNAVAILABLE` (the marine request failed; retried later) or `INCOMPLETE_DATA` (an input is missing on some day).
- **`fetchedAt`** — when Open-Meteo was last asked for the oldest of the seven days served.
- **`stale`** — `true` only when this request tried to refresh expired weather data and the attempt failed, so older stored weather was served. It is not a measure of data age (use `fetchedAt`) and says nothing about marine data.

Errors carry a code in `extensions.code`: `BAD_USER_INPUT` (empty or over-long `city`), `LOCATION_NOT_FOUND`, `UPSTREAM_UNAVAILABLE` (Open-Meteo is unavailable and nothing usable is stored), `INTERNAL_SERVER_ERROR` (anything unexpected; generic message, details only in the logs). Malformed HTTP requests get `BAD_REQUEST`.

## How it works

1. **Location.** The search text is normalised and looked up in Postgres; only a new search calls Open-Meteo geocoding. The result is stored, so the same text always means the same place.
2. **Weather.** The week is served from Postgres while all seven days are stored and the weather is younger than the TTL (default 1 hour). Otherwise the service fetches the weather and marine forecasts for exactly those dates, stores them in one upsert, and serves what Postgres then holds. Concurrent requests for the same location and week share one refresh.
3. **Scores.** Raw weather is stored; scores are computed on read: `score = round(100 × gate × quality)`, where gates decide whether an activity is possible at all (snow on the ground, rideable waves, no downpour or gale) and quality is a weighted mean of how pleasant the conditions are. Every threshold is a small curve in one table per activity under [`src/domain/`](src/domain/).

Refresh rules worth knowing:

- **A partial week is never served.** If a refresh fails and the stored week is incomplete, the request fails with `UPSTREAM_UNAVAILABLE`.
- **Weather and marine data are fetched and replaced as one unit.** If only the marine request fails, the weather is still stored and served, and surfing shows `MARINE_TEMPORARILY_UNAVAILABLE` until the marine retry window (`MARINE_RETRY_SECONDS`, default 5 minutes) has passed and a retry succeeds.
- **A refresh requested later always wins.** Each stored row records when its refresh was requested, and an upsert may only replace an older row, so a slow refresh finishing last cannot overwrite newer data.

## Assumptions

These are the questions I would normally settle with a product manager; the assumption taken for each is in [docs/DECISIONS.md](docs/DECISIONS.md#assumptions-and-open-product-questions).

- "Rank" means ranking the 7 days within each activity; scores are not comparable across activities.
- Days are local to the location, scored from daily aggregates (rain at night still counts).
- Skiing is judged from snow and weather at the town's coordinates, not at a ski resort.
- Surfing is judged from the offshore wave model near the town; wind direction, tides and water temperature are ignored.
- Indoor sightseeing is always possible and scores higher when outdoor conditions are worse.
- Thresholds and weights are judgment calls for a recreational user, not validated with domain experts.

## Limitations

- **Scoring numbers are unvalidated**; for example, a sunny day at 0 °C scores 68 for outdoor sightseeing.
- **`fetchedAt` says when we asked, not how old the forecast is.** Open-Meteo's model run may be older. Ordering refreshes by request time also trusts that server clocks agree, and the seven days of a week can come from different refreshes around local midnight.
- **Timeouts bound each step, not a whole request.** Each Open-Meteo call (`UPSTREAM_TIMEOUT_MS`), each database connection attempt and each SQL statement (`DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`) has its own timeout. There is no end-to-end deadline: a request that makes several of these calls can take longer than any single timeout, and while Open-Meteo is down a request for an expired city waits for the timeout before falling back.
- **One invalid value in an Open-Meteo response rejects the whole response** (missing values are fine; out-of-range or non-numeric ones are not).
- **A known advisory in a transitive dependency** (`@graphql-tools/utils`, via Apollo Server) cannot be resolved within Apollo's supported versions. Its preconditions do not apply to this service; the analysis is in [docs/DECISIONS.md](docs/DECISIONS.md).

## Security notes

- `city` is trimmed and limited to 1–100 characters.
- User text only ever becomes a query parameter of requests to fixed Open-Meteo base URLs; it never forms a host or path.
- SQL is parameterised (Drizzle). Configuration and secrets come only from environment variables; `.env.example` holds local development values.
- Error responses never include stack traces, file paths or upstream details; unexpected errors are logged in full and returned as a generic message. This includes malformed HTTP requests.
- The schema has no recursive types, so query depth is bounded by design. Apollo's CSRF protection is on; operation batching is off.
- **Not mitigated:** the endpoint is unauthenticated and not rate limited, and every new city costs upstream calls and stored rows. Introspection and Apollo's landing page are on, as in development.

## Configuration

| Variable                                                     | Default      | Meaning                                                                 |
| ------------------------------------------------------------ | ------------ | ----------------------------------------------------------------------- |
| `DATABASE_URL`                                               | — (required) | PostgreSQL connection string                                            |
| `PORT`                                                       | `4000`       | HTTP port                                                               |
| `FORECAST_TTL_SECONDS`                                       | `3600`       | How long stored weather is served before a refresh                      |
| `MARINE_RETRY_SECONDS`                                       | `300`        | How soon a failed marine request is retried (never longer than the TTL) |
| `UPSTREAM_TIMEOUT_MS`                                        | `3000`       | Timeout for each Open-Meteo request                                     |
| `DB_CONNECTION_TIMEOUT_MS`                                   | `5000`       | Timeout for opening a database connection                               |
| `DB_STATEMENT_TIMEOUT_MS`                                    | `5000`       | Postgres `statement_timeout` for every query                            |
| `GEOCODING_BASE_URL`, `FORECAST_BASE_URL`, `MARINE_BASE_URL` | Open-Meteo   | Upstream base URLs (useful for tests and outage demos)                  |

## Project layout

```
src/
  config.ts             environment variables, validated
  domain/               pure scoring, availability, ranking and date logic
  openmeteo/client.ts   Open-Meteo requests, response validation, UpstreamError
  db/                   Drizzle schema and connection pool
  services/             location lookup and forecast caching / refresh
  graphql/              schema, resolver, error handling, HTTP server
  index.ts              wires everything together
drizzle/                generated SQL migrations
test/unit/              no network, no database
test/integration/       real Postgres, fake Open-Meteo
docs/DECISIONS.md       decision log
```

## Data

Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Open-Meteo's free API is for non-commercial use and is rate-limited.
