/** The API contract. No type refers back to itself, so query depth is bounded by design. */
export const typeDefs = /* GraphQL */ `
  enum Activity {
    SKIING
    SURFING
    OUTDOOR_SIGHTSEEING
    INDOOR_SIGHTSEEING
  }

  "Why an activity cannot be judged. Unavailable never means bad weather."
  enum UnavailableReason {
    "The marine request succeeded but there is no wave data on any day (inland)."
    NO_MARINE_DATA
    "The marine request failed; it is retried later."
    MARINE_TEMPORARILY_UNAVAILABLE
    "An input this activity needs is missing on at least one day."
    INCOMPLETE_DATA
  }

  type Query {
    "Ranks the next 7 days (location-local) for each activity. city: 1-100 characters."
    activityRankings(city: String!): ActivityRankings!
  }

  type ActivityRankings {
    location: Location!
    "ISO-8601 UTC: when Open-Meteo was last asked for the oldest of the seven days served."
    fetchedAt: String!
    """
    True only when this request tried to refresh expired weather and the attempt failed, so
    older stored weather was served. Not a measure of age (see fetchedAt); never about marine data.
    """
    stale: Boolean!
    "Always four, in Activity order."
    activities: [ActivityRanking!]!
  }

  type Location {
    id: ID!
    name: String!
    country: String
    admin1: String
    latitude: Float!
    longitude: Float!
    timezone: String!
  }

  type ActivityRanking {
    activity: Activity!
    available: Boolean!
    "Set exactly when available is false."
    unavailableReason: UnavailableReason
    "Exactly 7 days in date order when available; empty otherwise."
    days: [DayScore!]!
  }

  type DayScore {
    "YYYY-MM-DD in the location's time zone."
    date: String!
    "0-100."
    score: Int!
    "1 = best; equal scores share a rank."
    rank: Int!
    reasons: [String!]!
  }
`;
