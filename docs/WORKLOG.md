# Worklog

This is a record of how the service was built: the problems, the calls that were made, what went wrong and how each claim was checked. It was reconstructed after implementation finished, on 16 November 2026, from the original Claude Code session log and the Git history. It is not a log kept during the work.

The reasoning behind each decision is in [DECISIONS.md](DECISIONS.md). The plan as approved before any code is in [PLAN.md](PLAN.md). All times are CET on 16 November 2026.

**Who did what.**

- **Claude Code**, an AI coding agent, produced most of the plan text, the code, the tests, the commit messages and the documentation, and ran the checks.
- **A second AI assistant** was used for background research. Private correspondence and that research are not reproduced here.
- **Me:** I set the scope, the constraints and the acceptance criteria, and drove the design reviews that reshaped the plan. I made the decisions this file attributes to me, and I accepted each phase only after reviewing its report and test results.
- **Attribution in this file:**
  - Where it matters who raised a risk or made a call, the text says so.
  - "The review found" means a finding Claude made while answering a review I asked for.
  - Block quotations are verbatim from my messages in the session.

## 1. Context and working approach

**Requirements.** The brief asked for a backend that ranks the next seven days for four activities in a given city, using Open-Meteo data that is persisted rather than fetched per request, built with Node.js and GraphQL. TypeScript was required for the submission. The constraint I set in my first review of the plan:

> Prefer simplicity over complexity. Don't add features just to demonstrate technical skills.

**Stack.** PostgreSQL was chosen over SQLite and Apollo Server over GraphQL Yoga. Drizzle was chosen as the database layer. The reasons recorded in [PLAN.md](PLAN.md) §2 and [DECISIONS.md](DECISIONS.md):

- **PostgreSQL:** a real upsert and concurrency story. SQLite would have needed no setup from a reviewer, but the refresh logic depends on concurrent writers and conditional upserts, and the tests should exercise those for real. The cost is Docker.
- **Apollo:** the most widely recognised server, and its landing page lets a reviewer run queries.
- **Drizzle:** a typed schema and plain SQL migrations committed to the repository.
- **Zod:** upstream JSON is treated as untrusted input.
- **Deliberately not added:** a repository layer, a DI framework, Testcontainers, an HTTP-mocking library, message brokers and infrastructure tooling. Each is listed in the plan.
- **Layering:** database access lives in two services, and dependencies (the Open-Meteo client, the database, the clock, `fetch`) are passed as plain function arguments, so tests can replace them.

**Working approach.**

- The plan was written and reviewed until it held up before any code existed.
- Implementation then ran in six phases: foundation, scoring, Open-Meteo client, persistence, GraphQL, CI and docs.
- Each phase had acceptance criteria and a mandatory test list from the plan. It ended with a full run of every check written so far and a written report, and the next phase started only after I accepted that report.
- Failing tests were committed before the scoring implementation.
- One process decision I later had to correct: I kept the plan and the session out of the repository. Claude's first plan had proposed committing both. See section 5.

## 2. Planning: design iterations before any code (15:28–16:45)

The first plan was revised to v5.1 over eight versions. Every problem below is a flaw in the written design, found before implementation began.

**Scoring formula: weighted mean → `min(mean, limiter)` → `gate × quality`.**

- **v1** scored each day as a weighted mean of factors.
- **v2:** the first review found that a must-have could be outvoted. A town with no snow still scored about 50 for skiing. The fix was to cap the score at a limiting factor.
- **v5:** I asked for concrete curves, weights and worked examples for every activity. Writing them out showed that the cap flattened the ranking: with a constant 20 cm snow base, all seven days scored the same, so there was nothing left to rank. The formula became `score = 100 × gate × quality`. Gates decide whether an activity is possible at all, and a weighted quality decides how good it is.
- **v5.1:** I asked for every reference example to be recomputed independently. That exposed a rounding problem: 39.5 evaluates to 39.4999… in floating point, so the code and the hand calculation disagreed. Fixed with `roundScore`.

**Seven complete local days.**

- **v2:** freshness had been tracked per location. After local midnight, six stored days would have counted as a fresh week. Freshness became a question of whether all seven dates are present.
- **v3:** upstream requests carry an explicit time zone and explicit dates, so "today" cannot differ between the service and Open-Meteo.
- **My calls:**
  - **v4:** stored data may be served as stale only when all seven days exist; otherwise the request fails.
  - **v4.1:** completeness is checked by date, not by row count.
- **v5:** specifying the single-flight key, which I had asked for, showed that it must include the week. Otherwise two requests either side of midnight would share the wrong refresh.
- **v5.1:** a proof for overlapping refreshes across midnight was added at my request.

**Ordering concurrent refreshes: completion time → request time.**

- **v3** introduced a guarded upsert: a row is replaced only by data with a newer `fetched_at`, stamped when the response arrived.
- **v4:** I required that a caller always receives what Postgres holds after the refresh, not the upstream payload.
- **v5.1:** reviewing v5, I asked to:
  > Reconcile the definition of fetched_at with its actual assignment after Promise.allSettled.
- **The analysis confirmed a real defect.** Refresh A is sent first, but its marine call hangs, so A finishes last. Stamped at completion, A would overwrite newer weather and good marine data from a refresh sent later. Stamping with the request time makes the refresh requested later win, whichever one writes first. The plan states the known limits of this rule instead of hiding them: ordering across instances trusts their clocks, and a week may mix rows from two refreshes.

**Weather freshness and marine availability are separate questions.**

- **v3:** marine data was made best-effort, with a flag recording whether the marine request succeeded. A marine outage therefore no longer blocks skiing and sightseeing.
- **v4:** I asked to keep marine retries simple, and a short retry window was added. In v4.1 I asked how it interacts with a TTL of 0, and the answer was a real flaw: a week without marine data stayed fresh for 300 s.7
- **v5.1:** I raised a second conflation, and it was confirmed: `stale` depended on the marine retry window. `stale` now means only "a refresh of expired weather failed". Marine problems are reported per activity.

**Missing data versus failed requests.**

- **My point (v4.1):** an inland location's successful all-null marine response must differ from a failed marine request.
- **My point (v5):** a geocoding miss must differ from a geocoding error, a timeout or a malformed response.
- **Resulting design:**
  - "not found" is a value, every upstream failure is one error type;
  - an activity is either fully available or unavailable with a reason;
  - missing inputs are never treated as zero.

**Consistent results for concurrent first lookups.** Two first searches for the same text can geocode to different places. I raised this before Phase 1:

> […] ensure the service returns the location associated with the persisted normalized lookup, rather than assuming the newly geocoded location won.

**Determinism and honest limits.**

- **v4.1:** at my request, tests no longer depend on live weather.
- **v5.1:** I made live Open-Meteo calls smoke tests only.
- **v4.1:** data that failed to persist is never returned.
- **Before approval:** I asked that deadlock avoidance be described as an expectation rather than a guarantee, and that database timeouts be configured and tested without claiming an end-to-end deadline.
- **The estimate** grew from two days to 22–26 hours once every test the reviews had added was counted ([PLAN.md](PLAN.md) §15). In practice, implementation ran from 16:47 until the last commit at 20:01 the same day.

The version approved at 16:45 is [PLAN.md](PLAN.md).

## 3. Implementation timeline

| Phase                      | Time        | Commits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Foundation              | 16:47–17:12 | [c3c277b](https://github.com/volkovillya/activity-weather-ranker/commit/c3c277b) scaffold and validated config · [64791d8](https://github.com/volkovillya/activity-weather-ranker/commit/64791d8) Postgres via Docker Compose · [1bb473f](https://github.com/volkovillya/activity-weather-ranker/commit/1bb473f) integration test project                                                                                                                                                                                                                                                                                   |
| 2. Scoring                 | 17:13–17:45 | [ed20174](https://github.com/volkovillya/activity-weather-ranker/commit/ed20174) failing tests first · [2ad5e3c](https://github.com/volkovillya/activity-weather-ranker/commit/2ad5e3c) implementation · [7039943](https://github.com/volkovillya/activity-weather-ranker/commit/7039943) refactor · [4ff9d54](https://github.com/volkovillya/activity-weather-ranker/commit/4ff9d54) defect fixes                                                                                                                                                                                                                          |
| 3. Open-Meteo client       | 17:45–17:58 | [0dca87d](https://github.com/volkovillya/activity-weather-ranker/commit/0dca87d) recorded fixtures · [909c9c1](https://github.com/volkovillya/activity-weather-ranker/commit/909c9c1) client with boundary validation · [e3d4380](https://github.com/volkovillya/activity-weather-ranker/commit/e3d4380) coordinate guard                                                                                                                                                                                                                                                                                                   |
| 4. Persistence and refresh | 17:55–18:20 | [b85be98](https://github.com/volkovillya/activity-weather-ranker/commit/b85be98) DB timeouts · [3d4704d](https://github.com/volkovillya/activity-weather-ranker/commit/3d4704d) schema, migration, pool · [2f7c8d5](https://github.com/volkovillya/activity-weather-ranker/commit/2f7c8d5) local dates · [b2ad280](https://github.com/volkovillya/activity-weather-ranker/commit/b2ad280) location service · [0f5ca1a](https://github.com/volkovillya/activity-weather-ranker/commit/0f5ca1a) forecast service · [ce94992](https://github.com/volkovillya/activity-weather-ranker/commit/ce94992) overlapping-refresh tests |
| 5. GraphQL API             | 18:20–19:37 | [becb2fa](https://github.com/volkovillya/activity-weather-ranker/commit/becb2fa) schema, resolver, entry point · [1dab5e9](https://github.com/volkovillya/activity-weather-ranker/commit/1dab5e9) advisory analysis · [62f8bb6](https://github.com/volkovillya/activity-weather-ranker/commit/62f8bb6) Express integration                                                                                                                                                                                                                                                                                                  |
| 6. CI and docs             | 19:38–20:01 | [7f844f9](https://github.com/volkovillya/activity-weather-ranker/commit/7f844f9) CI · [c1dff8c](https://github.com/volkovillya/activity-weather-ranker/commit/c1dff8c) README · [0a7b703](https://github.com/volkovillya/activity-weather-ranker/commit/0a7b703) final docs                                                                                                                                                                                                                                                                                                                                                 |

The branch was then pushed. CI passed on the branch and after a fast-forward merge to `main`, with no merge commit.

## 4. Corrections and changes of direction during implementation

**Scoring defects (Phase 2).** I asked for a check of NaN, Infinity and invalid input, of the rounding workaround, and of whether the explanations stay honest near thresholds. It found three code defects:

- a NaN or infinite sunshine or daylight value produced a normal-looking score (8 of 51 input combinations);
- an empty week produced contradictory output;
- with one decimal, a 0.79 m wave was explained as "Limited by wave height 0.8 m", which is exactly where that gate is fully open.

All three were fixed in [4ff9d54](https://github.com/volkovillya/activity-weather-ranker/commit/4ff9d54). Two-decimal explanations were a change to the specification. I approved it after it had already been committed. I also decided an open question: range and type validation belongs once, at the Open-Meteo boundary, rather than inside every scoring function.

**Unvalidated coordinates (Phase 3).** I asked whether invalid coordinates are rejected. They were not: `String(NaN)` would have been sent upstream as the text `"NaN"`. Fixed in [e3d4380](https://github.com/volkovillya/activity-weather-ranker/commit/e3d4380).

**A flaky test, not a flaky service (Phase 4).** The concurrent-lookup test failed in 3 of 5 runs of its file. The cause was the test, not the service: it assumed which of two concurrent requests reaches the geocoder first. It was fixed rather than re-run until green.

**Overlapping refreshes with different marine outcomes (Phase 4).**

- I asked for a check of whether an older refresh whose marine call failed can overwrite a newer, complete one. The guard already prevented it, so the change added tests only ([ce94992](https://github.com/volkovillya/activity-weather-ranker/commit/ce94992)).
- The mirror case stays a documented trade-off: when the newer refresh is the one with the failed marine call, its newer weather wins and surfing is unavailable until the retry window passes.

**Dependency advisory (Phase 5).**

- `@graphql-tools/utils`, pulled in by Apollo, has a high-severity advisory, and no version Apollo supports is free of advisories.
- **Requirements I set for the review:** no forced upgrades and no unsupported overrides, and:
  > Do not treat "the function is not called directly" as sufficient evidence.
- **Result:** the analysis checks the advisory's exploit preconditions against how this service actually works. A first runtime check proved nothing, because its hook never loaded; it was redone with a positive control. A regression test fails if incremental delivery is ever enabled ([1dab5e9](https://github.com/volkovillya/activity-weather-ranker/commit/1dab5e9)).

**Stack traces over HTTP: standalone server → Express integration (Phase 5).**

- **Finding.** The same review sent real HTTP requests and found a defect the test suite had not caught. A malformed JSON body got an HTML page with a stack trace and absolute file paths. Apollo's `startStandaloneServer` passes body-parser errors to a default handler that cannot be changed. A `mutation` was also misreported as an internal error.
- **Options considered:**
  - Apollo's official Express integration, the one the review recommended;
  - a hand-written HTTP handler;
  - forcing production mode.
- **My decision:**
  > I don't want to implement and maintain a custom HTTP handler when a well-established integration already exists.
- **Result** ([62f8bb6](https://github.com/volkovillya/activity-weather-ranker/commit/62f8bb6)):
  - pre-GraphQL errors return JSON with fixed wording;
  - unsupported operations are validation errors;
  - CORS, the 50 MB limit, CSRF protection and graceful shutdown were kept.
    The new 50 MB test first failed and left an open handle, because the body parser drains the request before rejecting it. It now sends a real 50 MB + 1 byte body.

**Polishing the decision log ([0a7b703](https://github.com/volkovillya/activity-weather-ranker/commit/0a7b703)).** The final documentation pass regrouped DECISIONS.md by topic. It also softened one entry: "was the first design and is wrong" became "was considered and rejected". The entries as they were added, commit by commit, are visible with `git log -p docs/DECISIONS.md`.

## 5. Verification and testing

**Test-first scoring.** At [ed20174](https://github.com/volkovillya/activity-weather-ranker/commit/ed20174) the suite fails (`Test Suites: 4 failed`). The 34 reference scores were not changed afterwards to fit the implementation.

**Concurrency tested deterministically against real Postgres.**

- A fake clock and promises settled by hand fix the order of events; there are no sleeps.
- "Several instances" are two service instances on one database.
- Covered cases:
  - ten concurrent calls share one refresh, that is one weather and one marine request;
  - a slow marine call cannot make an older refresh win;
  - overlapping weeks across local midnight are checked in both completion orders.
- These tests prove the ordering rules for the interleavings they set up. They do not prove behaviour under clock skew, under load, or that deadlocks cannot occur.

**Checks run during the session that are not part of CI.** Their results are recorded in the session log and in DECISIONS.md; the scripts were not kept in the repository.

- **Deliberate-defect checks.** From Phase 2 on, key rules were broken on purpose to confirm that a test fails.
  - In the services, 12 of 13 such defects were caught. The thirteenth is equivalent to the original code: counting rows equals matching dates, because the query filters by date and `(location_id, date)` is the primary key.
- **Exact-arithmetic check of the rounding helper.**
- **Runtime check for the dependency advisory.**
- **Staged-tree checks.** Before each commit, the staged files were checked out separately and type-checked, linted and tested. Jest compiles with swc and does not type-check, and this step caught two problems in test code that the normal run had missed: a type error in a test fake and an import of a file that was not yet staged.

**Final state:**

- 236 unit and 64 integration tests;
- lint and typecheck clean;
- CI green on the branch ([run](https://github.com/volkovillya/activity-weather-ranker/actions/runs/43935813477)) and on `main` ([run](https://github.com/volkovillya/activity-weather-ranker/actions/runs/43936321549)).

## 6. Intentional cuts and known limitations

The full cut list with reasons is in [DECISIONS.md](DECISIONS.md#cut-with-the-reason). The cuts that shaped the design most:

- **No cross-instance refresh lock.** Duplicate refreshes from several instances are wasteful but safe, because of the guarded upsert.
- **No retries, backoff or circuit breaker.** Every upstream call has its own timeout.
- **No scheduled pre-warming.** The set of cities is unbounded; refreshing on demand costs nothing for cities nobody asks about.
- **No partial weeks.** During an outage that spans local midnight, a city with six stored days gets an error rather than a short week.
- **No authentication or rate limiting.** Recorded as the main operational risk of an open endpoint.

**Known limitations** are listed in the README and DECISIONS.md:

- the scoring thresholds are unvalidated judgment calls;
- `fetchedAt` is the request time, not the forecast's age;
- there is no end-to-end request deadline;
- the advisory exception above.

**Process.** Keeping the plan and the session private left the commit history and a polished decision log as the only public evidence of how the work went. This worklog and the approved plan were added after implementation to correct that.

## 7. Post-review hardening (16–17 November)

This phase was not part of the approved plan. [PLAN.md](PLAN.md) is unchanged. The phase was planned separately after the original work had been merged, and this section was written at its end.

**What triggered it.** After the submission was on `main`, I asked for a read-only review of how the finished service would behave under load spikes, failures, several instances and abuse. The review was done against the code, without changing it, and I had its conclusions checked by a second AI review. Two risks mattered even without production traffic:

- **Request amplification.** Root query fields resolve concurrently, so one request with hundreds of aliased `activityRankings` fields could trigger hundreds of geocoding and forecast calls against Open-Meteo's shared quota. The 50 MB body limit made room for that.
- **Unbounded upstream work.** Single-flight removed duplicate refreshes of one city and week, but nothing capped how many different refreshes and geocodes ran at once.

I chose a small hardening pass with tests rather than new infrastructure, on a separate branch, `feature/post-review-hardening`, in three gated steps. Two of its design rules came from the second review, and I adopted them before implementation:

- **A shared limiter.** One limiter is shared by geocoding and refreshes.
- **Fail-fast admission.** The limiter refuses at once instead of queueing.

**Changes:**

|     | Change                                                                                                                                                                                                                                                                                                                                                         | Commit                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| H1  | **One city per operation.** I asked for a recommendation between 1 and 5 and approved 1. With one city per request, any per-request limit maps directly to upstream cost, at most three calls. The rule counts distinct response keys through aliases and fragments, so it cannot be bypassed, while repeated selections of the same field are still accepted. | [6009446](https://github.com/volkovillya/activity-weather-ranker/commit/6009446) |
| H2  | **Request bodies limited to 100 KB.** This reverses the earlier decision to keep the standalone server's 50 MB: a large body is buffered and parsed synchronously, and it was the only way to fit thousands of aliases into one request.                                                                                                                       | [5d67875](https://github.com/volkovillya/activity-weather-ranker/commit/5d67875) |
| H4  | `**DB_POOL_MAX`.** The pool's implicit default of 10 is now explicit, so instances × pool size can be kept below Postgres's `max_connections`.                                                                                                                                                                                                                 | [15abaad](https://github.com/volkovillya/activity-weather-ranker/commit/15abaad) |
| H3  | **A shared, fail-fast limiter for upstream operations per process.** See the details below.                                                                                                                                                                                                                                                                    | [24b2ec0](https://github.com/volkovillya/activity-weather-ranker/commit/24b2ec0) |
|     | **README update**                                                                                                                                                                                                                                                                                                                                              | [14def24](https://github.com/volkovillya/activity-weather-ranker/commit/14def24) |

**H3 in detail.**

- **What one permit covers.** A geocode takes one permit. A refresh takes one permit for its weather and marine calls together, because a permit per HTTP call could have recorded a refused marine call as a marine failure and discarded good wave data.
- **When a permit is taken.**
  - Refresh permits are taken inside single-flight, so callers that join a refresh take none.
  - Searches take a permit only after the stored lookup misses.
- **Release.** Permits are released in `finally` as soon as the upstream calls settle.
- **A refused refresh writes nothing and counts as a failed attempt**, so the existing meaning of `stale` holds. At my request, the three cases were checked against the forecast service and its existing tests before any code was written:
  - an expired complete week is served with `stale: true`;
  - fresh weather with a due marine retry is served with `stale: false`;
  - with no complete week, the request fails with `UPSTREAM_UNAVAILABLE`.

**How it was verified.**

- **Failing tests first.** Each change started with tests that failed against the existing code. For example, a 100 KB + 1 byte body returned 400 instead of 413, and the pool was created with 10 connections instead of the configured 3.
- **Deliberate-defect checks.** In H1 all 6 deliberate defects were caught, in H2 both, in H4 the one, and in H3 all 10. For example: a permit never released, a permit taken outside single-flight, a refused refresh treated as a success.
- **Tests that were not failing first.** A few H3 tests passed before the change, because the services did not use the limiter yet: the permit-recovery tests and the test where ten callers share one permit. Their value is shown by the deliberate-defect checks, not by a failing-first run.
- **Tests that prove nothing was written.** They compare every stored column before and after a refused refresh.
- **Final results:**
  - 253 unit and 90 integration tests;
  - lint, Prettier and typecheck clean in a fresh clone;
  - no new runtime advisories.

**Deliberately not done:**

- **Rate limiting inside the application.** Behind a load balancer, the client address depends on proxy configuration, and counters in each instance multiply. It belongs at a gateway, and the README says so.
- **The shared Open-Meteo quota is still not enforced across instances.** The limiter bounds concurrency per process, not request rate.
- **Redis, distributed locks, queues, circuit breakers, retries.** No measured need. The guarded upsert already keeps concurrent writes correct.
- **Negative caching, fetching an eighth day to avoid the midnight refresh wave, skipping marine calls for inland cities, metrics and request-latency logging, read replicas, PgBouncer.** Recorded as production ideas in the review, not needed for the brief.

**Status.** The branch was pushed and GitHub Actions passed on it ([run](https://github.com/volkovillya/activity-weather-ranker/actions/runs/43978944560): 253 unit and 90 integration tests). `main` was then fast-forwarded to [14def24](https://github.com/volkovillya/activity-weather-ranker/commit/14def24), with no merge commit, and CI passed on `main` as well ([run](https://github.com/volkovillya/activity-weather-ranker/actions/runs/43979190306)). This worklog and [PLAN.md](PLAN.md) were added afterwards in a separate documentation commit.
