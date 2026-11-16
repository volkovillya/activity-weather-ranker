# Open-Meteo fixtures

Real responses, recorded once on 2026-11-16 and committed unchanged (excluded from Prettier),
so the client tests run offline and deterministically. Tests derive invalid variants from these
files in code rather than storing hand-edited copies.

Data © Open-Meteo, licensed under [CC BY 4.0](https://open-meteo.com/en/license).

| File | Request |
| --- | --- |
| `geocode-biarritz.json` | `geocoding-api.open-meteo.com/v1/search?name=Biarritz&count=1&language=en&format=json` |
| `geocode-not-found.json` | same, `name=Zzqxqxq` (no `results` key) |
| `forecast-biarritz.json` | `api.open-meteo.com/v1/forecast?latitude=43.48055&longitude=-1.55684&timezone=Europe/Paris&start_date=2026-11-16&end_date=2026-11-22&daily=temperature_2m_max,precipitation_sum,snowfall_sum,snow_depth_max,wind_speed_10m_max,sunshine_duration,daylight_duration&temperature_unit=celsius&wind_speed_unit=kmh&precipitation_unit=mm` |
| `forecast-error-400.json` | the same forecast request with `latitude=999` (HTTP 400) |
| `marine-biarritz.json` | `marine-api.open-meteo.com/v1/marine?latitude=43.48055&longitude=-1.55684&timezone=Europe/Paris&start_date=2026-11-16&end_date=2026-11-22&daily=wave_height_max,swell_wave_period_max` |
| `marine-krakow-inland.json` | the same marine request for Kraków (`50.06143, 19.93658`, `Europe/Warsaw`): every value is `null` |
