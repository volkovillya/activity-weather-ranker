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
- **Dependencies are pinned to exact versions** so that a reviewer installs exactly what was tested.

### Configuration

- **Environment variables validated with zod at startup**, with one error that lists every invalid variable and never echoes values (a malformed `DATABASE_URL` would otherwise print its password).
- **Integers must be plain digit strings.** `z.coerce.number()` was rejected: it turns an empty string into `0`, so an accidental `FORECAST_TTL_SECONDS=` would silently disable caching.
- **Defaults:** forecast TTL 1 hour (Open-Meteo's models update every 1–6 hours), marine retry window 5 minutes, upstream timeout 3 seconds. All three are judgment values, not measured.
- **Open-Meteo base URLs are configuration**, so tests and outage demos can point the service at a fake or unreachable host without code changes.

### Storage

- **PostgreSQL 17, run locally with Docker Compose.** SQLite was considered: zero setup for a reviewer, but the refresh logic depends on concurrent writers and conditional upserts, which Postgres lets us test for real. The cost is that running the service and its integration tests needs Docker. The Compose credentials are for local development only.

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
