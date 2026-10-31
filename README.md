# ImgMap backend

Builds the data the ImgMap app reads: each country's AIP charts, mirrored and georeferenced, and its airway network. Everything is published as static files on a CDN, so there is no server to run.

- **Protects the eAIPs.** Each AIP is read at most once per AIRAC cycle, however many people use the app.
- **Georeferencing happens here.** Improvements reach every install without an app update.
- **Costs about nothing.** A scheduled GitHub Actions job plus Cloudflare R2 (no egress fees). The output is a plain directory, so a VPS with any web server works too.

```
GitHub Actions (daily) → python -m imgmap_backend.pipeline --publish-r2 → R2 (public, behind Cloudflare's cache)
                                  each file uploaded as soon as it's written      ↑ apps read JSON + PDFs
```

Results are published as they're produced: PDFs as they download, each aerodrome's chart list when it's done, and the airway network when it's built. A run that's cancelled or times out loses nothing. Each run has a time budget (`--max-minutes`); when it runs out, the progress record is saved and the workflow queues a follow-on run that resumes. A big first run is simply split across several runs.

**What apps see:** an edition is listed in `editions.json` once it's complete. While a country has no complete edition yet (its first run), the edition being built is listed straight away and fills in as aerodromes finish.

## Running locally

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q tests
.venv/bin/python -m imgmap_backend.pipeline --out out --only VIDP,VOBL
```

`--only` limits a run to some aerodromes, for testing. Partial runs never mark an edition as published.

## What gets published (`/v1/`)

| Path | Content |
|---|---|
| `v1/countries.json` | Countries available: id, name, ISO code, authority, ICAO prefixes, map centre. The app builds its country list from this, so **adding a country needs no app release** |
| `v1/<country>/editions.json` | The edition in force and any announced: `id`, `name`, `effective` |
| `v1/<country>/<edition>/aerodromes.json` | Aerodromes with chart counts |
| `v1/<country>/<edition>/ad/<ICAO>.json` | The aerodrome's charts (below) |
| `v1/<country>/<edition>/enroute.json` | The airway network and airspace (the app's `EnrouteData` format; below) |
| `v1/state.json` | Pipeline state, read by the next run |
| `pdf/<sha256>.pdf` | Mirrored charts, content-addressed and immutable |

A chart entry:

```json
{
  "file": "VIDP-ILS-LOC-RWY-27.pdf", "title": "ILS LOC RWY 27", "category": "approach",
  "pdf": {"path": "pdf/1f3c….pdf", "sha256": "1f3c…", "bytes": 374333},
  "page": {"width": 595.5, "height": 842.26, "rotation": 0},
  "georef": {
    "revision": 1, "algorithm": 6, "method": "grid labels", "projection": "utm43n",
    "conformal": false, "accuracyM": 14.0, "estimated": false,
    "points": [{"u": 0.6752, "v": 0.1583, "lat": 28.8333333, "lon": 77.6666667}],
    "footprint": [[29.06, 76.73], [29.07, 77.85], [27.67, 77.86], [27.66, 76.75]],
    "notToScale": []
  }
}
```

Charts that can't be georeferenced have `"unusable": "<reason>"` and no `georef`.

`enroute.json` lists, beside the routes, the airspace from ENR 2.1 (FIRs, control areas, TMAs and control zones) with the units serving it:

```json
{
  "n": "Delhi- LDP1 (Lower Delhi ACC North East)", "k": "cta",
  "rings": [[[28.5669, 77.0936], [27.3356, 77.9531], [26.5869, 79.0411]]],
  "approx": true,
  "u": "FL 255", "uft": 25500, "l": "FL 155", "lft": 15500, "cls": "D",
  "units": [{"n": "Delhi ACC", "cs": "Delhi Control/Delhi Radar (RSR)", "h": "H24", "f": [120900, 134500]}]
}
```

- `k` is `fir`, `cta`, `tma` or `ctr`.
- `rings` are `[lat, lon]` polygons, arcs and circles already drawn as points: the outer boundary, then any holes. Absent when the limits can't be read (no coordinates published).
- `approx` marks a boundary partly following a border or coastline, or a misprinted arc, drawn as a straight line.
- `uft`/`lft` are the limits in feet (flight levels as hundreds of feet); `uft` is absent for `UNL`.
- `f` are frequencies in kHz (VHF `120900` = 120.900 MHz, HF `10018`).

- `u`, `v` are positions as **fractions of the displayed page** (after rotation), so they don't depend on the size an app renders the PDF at.
- The app fits the points in `projection` (`merc` or `utm<zone><n|s>`), with scale and rotation only when `conformal` is true.
- `footprint` is the page's corners on the ground, for "you're here" checks.

### Compatibility rules

1. **`v1` only ever gains fields.** Apps ignore fields they don't know.
2. **Unknown values are skipped, not guessed.** An app that meets an unknown `category` or `projection` treats that chart as unusable.
3. **New projections come with a fallback.** If a future algorithm uses a projection v1 apps don't know (for example Lambert conformal conic), the entry must also carry v1-compatible `points`/`projection`, with the new ones in additional fields.
4. **`revision` increases whenever a chart's georef changes.** Apps compare it to replace stale control points (but never ones the user placed by hand).
5. **Breaking changes go to `/v2/`,** published beside `/v1/` until old app versions are retired.

## Rolling out an improvement

Change `imgmap_backend/georef.py`, add a test, and **bump `ALGORITHM_VERSION`**. The next run:
- re-georeferences every chart, using PDFs from our own mirror, not the eAIP;
- republishes the data;
- increments each changed chart's `revision`, which apps pick up when they next open a chart list.

## Adding a country

Write `imgmap_backend/countries/<name>.py` with a `Country` (see `india.py`) and add it to `all_countries()` in `countries/__init__.py`. A `Country` holds:
- ICAO prefixes;
- how to find editions on the AIS website;
- page naming (`page_prefix`, `language`);
- chart index pages and file-name rules.

Test it with `--country <id> --only <ICAO>`.

## Setting up hosting

### Cloudflare R2 (recommended)
1. **Turn on R2** (*R2 Object Storage*). It asks for a payment method, but this usage stays within the free tier: 10 GB of storage, no egress fees.
2. **Create a bucket**, e.g. `imgmap`.
3. **Connect a custom domain** in the bucket's *Settings → Custom Domains* (live: `charts.daniyaalkhan.com`). Leave the `r2.dev` URL disabled: it's throttled, uncached, and can't take security rules.
4. **Create an API token:** *R2 → Manage API tokens*, Object Read & Write, scoped to the bucket only.
5. **Cache everything:** on the zone, *Caching → Cache Rules*, for the hostname, set *Eligible for cache* with Edge TTL *Use cache-control header if present*. Cloudflare doesn't cache JSON by default; with this rule, a flood of requests is answered from cache and never reaches (or bills) R2.
6. **Rate limit:** *Security → WAF → Rate limiting rules*, for the hostname, per IP, more than 100 requests per 10 seconds → block. Normal app use is a few requests when a chart list opens, plus one per chart downloaded.
7. **Billing alert:** *Notifications*, usage-based billing. R2 has no hard spending cap.

Don't enable **Bot Fight Mode** on this hostname: it challenges non-browser clients, which includes the app.

### GitHub Actions
Push this repository to GitHub. Public is recommended: unlimited Actions minutes, and there's nothing secret in it. Then add, under *Settings → Secrets and variables → Actions*:

| Kind | Name | Value |
|---|---|---|
| secret | `R2_ACCESS_KEY_ID` | from the API token |
| secret | `R2_SECRET_ACCESS_KEY` | from the API token |
| variable | `R2_ACCOUNT_ID` | your Cloudflare account id |
| variable | `R2_BUCKET` | `imgmap` |
| variable | `PUBLIC_BASE_URL` | e.g. `https://data.example.com/` |
| variable | `CONTACT` | an email address, sent to AIS servers in the User-Agent |

Run the workflow once by hand (*Actions → pipeline → Run workflow*). The first full run downloads every chart, a few GB over several hours, split across runs that queue each other. Later runs only fetch what changed. To test, give the run an `only` value, e.g. `VIDP`.

### VPS instead
The pipeline only needs Python and writes a directory. Serve `out/` with any web server (Caddy, nginx) and run from cron:

```cron
30 2 * * *  cd /opt/imgmap-backend && .venv/bin/python -m imgmap_backend.pipeline --out /var/www/imgmap --contact you@example.com >> /var/log/imgmap.log 2>&1
```

Without `--previous`, state is read from the output directory.

## Flight replay website (`site/`)

`site/replay/` is a static page, published at `/replay/` beside the data: upload a KML or KMZ track (FlightAware, ForeFlight, Flightradar24, Google Earth), or follow a flight live, and watch the aircraft move on any georeferenced chart, with an altitude profile. It finds the charts the flight crosses from their footprints, using the AIP edition in force on the flight's date. The file never leaves the browser.

It reads `/v1/` and `/pdf/` from its own origin, so the bucket needs no CORS rules. The positioning math (`geo.js`) is a port of the app's and is tested against the footprints the pipeline publishes.

```sh
node --test tests/site/*.test.mjs
.venv/bin/python -m imgmap_backend.site serve      # http://localhost:8770/replay/, data from the live site
.venv/bin/python -m imgmap_backend.site publish    # what .github/workflows/site.yml runs on each push to site/
```

### Live flights (`live/`)

The page can also follow a flight live: find one by callsign or registration, or list the aircraft on the open chart. Positions come from `/live/` on the same hostname, a Cloudflare Worker (`live/`) that asks the source and caches each answer for 5–10 s at the edge, so everyone following one flight costs one upstream call per period. The page polls every `pollS` seconds (the Worker says how often), stops while the tab is hidden, and moves the aircraft on between reports at its reported speed, track and vertical speed.

The source is [adsb.lol](https://adsb.lol/): free, no key, data under the ODbL (the page credits it). Coverage comes from volunteers' receivers and is thin in parts of India. adsb.lol sends no CORS headers, which is one reason for the Worker; the other is that a paid source's key must stay off the page.

**Changing the source** (e.g. to Flightradar24): add `live/src/<name>.js` with the same four members as `adsblol.js` (`source`, `pollS`, `cacheS`, and `area`/`search`/`aircraft` returning the shape described in `live/src/index.js`), register it in `PROVIDERS`, set `PROVIDER` in `wrangler.toml`, and put its key in a Worker secret (`npx wrangler secret put FR24_API_KEY`), read from `env`. A metered source wants a longer `pollS` and `cacheS`. The page doesn't change: aircraft `id`s are the provider's own.

```sh
node --test tests/live/*.test.mjs
node live/dev.mjs                                   # the Worker on http://localhost:8787, no edge cache
.venv/bin/python -m imgmap_backend.site serve --live http://localhost:8787
cd live && npx wrangler deploy                      # what .github/workflows/live.yml runs on each push to live/
```

The Worker's route (`charts.daniyaalkhan.com/live/*`) needs an API token with *Workers Scripts: Edit* on the account and *Workers Routes: Edit* on the zone, stored as the repository secret `CLOUDFLARE_API_TOKEN` (with `vars.R2_ACCOUNT_ID` as the account).

## Costs and upkeep
- **Storage:** India is roughly 3 GB of PDFs. Charts unchanged between editions are stored once, so growth per cycle is small.
- **Compute:** a full first run is one to two hours of Actions time; a normal daily run takes seconds.
- **Upkeep:** none routine. If an AIS redesigns its website, adjust that country's file.

## Licensing
The charts are the publishing authorities' copyright. Check each authority's terms on redistribution before publishing a mirror for public use.
