CREATE TABLE "daily_forecasts" (
	"location_id" integer NOT NULL,
	"date" date NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"marine_fetched" boolean NOT NULL,
	"temp_max_c" double precision,
	"precipitation_mm" double precision,
	"snowfall_cm" double precision,
	"snow_depth_m" double precision,
	"wind_speed_max_kmh" double precision,
	"sunshine_s" double precision,
	"daylight_s" double precision,
	"wave_height_max_m" double precision,
	"swell_period_max_s" double precision,
	CONSTRAINT "daily_forecasts_location_id_date_pk" PRIMARY KEY("location_id","date")
);
--> statement-breakpoint
CREATE TABLE "location_lookups" (
	"query_normalized" text PRIMARY KEY NOT NULL,
	"location_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"admin1" text,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"timezone" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_forecasts" ADD CONSTRAINT "daily_forecasts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_lookups" ADD CONSTRAINT "location_lookups_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;