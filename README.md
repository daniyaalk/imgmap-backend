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
| `v1/<country>/<edition>/enroute.json` | The airway network (the app's `EnrouteData` format) |
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

## Costs and upkeep
- **Storage:** India is roughly 3 GB of PDFs. Charts unchanged between editions are stored once, so growth per cycle is small.
- **Compute:** a full first run is one to two hours of Actions time; a normal daily run takes seconds.
- **Upkeep:** none routine. If an AIS redesigns its website, adjust that country's file.

## Licensing
The charts are the publishing authorities' copyright. Check each authority's terms on redistribution before publishing a mirror for public use.
