"""Builds the static dataset apps read: chart lists with georeferencing,
mirrored PDFs, and en-route networks.

    python -m imgmap_backend.pipeline --out out/ [--country in-aai]
        [--only VIDP,VOBL] [--previous https://cdn.example/ | out/]

Reads each eAIP at most once per AIRAC cycle. A chart is downloaded only
when it may have changed (HEAD fingerprint differs) and georeferenced
again only when its PDF changed or ALGORITHM_VERSION was bumped; PDFs
needed for re-georeferencing come from our own mirror, not the eAIP.

Output (see README for the format and its compatibility rules):
    v1/countries.json
    v1/<country>/editions.json
    v1/<country>/<edition>/aerodromes.json
    v1/<country>/<edition>/ad/<ICAO>.json
    v1/<country>/<edition>/enroute.json
    v1/state.json              (pipeline state for the next run)
    pdf/<sha256>.pdf
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

import requests

from . import georef as gr
from .airspace import parse_airspace_page
from .countries import Country, all_countries
from .eaip import MAP_CATEGORIES, AipError, ChartRef, Edition, EaipSource, PoliteClient, parse_route_page
from .geo import Georeference
from .pdfpage import extract_page
from .publish import Publisher, R2Publisher

SCHEMA = 1
# Bumped when enroute.json gains data (2: airspace); published editions get
# a new one without their charts being rechecked.
ENROUTE_VERSION = 2
log = logging.getLogger("pipeline")


# --- State between runs ----------------------------------------------------


class State:
    """What earlier runs learned, so unchanged charts aren't fetched or
    recomputed. Published as v1/state.json beside the data."""

    def __init__(self, data: dict | None = None):
        data = data or {}
        # sha256 -> {"algorithm", "revision", "result": {...}}
        self.charts: dict = data.get("charts", {})
        # "<country>|<icao>|<file>" -> {"fingerprint", "sha256", "bytes"}
        self.files: dict = data.get("files", {})
        # "<country>|<edition>" -> algorithm version it was fully published with
        self.editions: dict = data.get("editions", {})
        # "<country>|<edition>" -> {icao: summary} for an edition still being
        # built: a run that runs out of time resumes from here.
        self.progress: dict = data.get("progress", {})
        # "<country>|<edition>" -> ENROUTE_VERSION of its published enroute.json
        self.enroute: dict = data.get("enroute", {})

    def to_json(self):
        return {
            "schema": SCHEMA,
            "algorithm": gr.ALGORITHM_VERSION,
            "charts": self.charts,
            "files": self.files,
            "editions": self.editions,
            "progress": self.progress,
            "enroute": self.enroute,
        }


def load_state(previous: str | None, out: Path) -> tuple[State, str | None]:
    """State from a previous publication: the bucket itself when publishing
    there (never a cached copy), else a URL or directory. Returns the state
    and, for URLs, the base to fetch mirrored PDFs from."""
    stored = Output.publisher.get("v1/state.json")
    if stored is not None:
        log.info("Resuming from the published state")
        return State(json.loads(stored)), previous
    if previous is None:
        local = out / "v1" / "state.json"
        return (State(json.loads(local.read_text())) if local.exists() else State()), None
    if previous.startswith(("http://", "https://")):
        base = previous if previous.endswith("/") else previous + "/"
        try:
            r = requests.get(urljoin(base, "v1/state.json"), timeout=60)
            if r.status_code == 200:
                return State(r.json()), base
            log.warning("No previous state at %s (%s); starting fresh", base, r.status_code)
        except requests.RequestException as e:
            log.warning("Could not read previous state: %s", e)
        return State(), base
    path = Path(previous) / "v1" / "state.json"
    return (State(json.loads(path.read_text())) if path.exists() else State()), None


# --- Charts ----------------------------------------------------------------


def chart_entry(chart: ChartRef, pdf: dict | None, page: dict | None, result: dict) -> dict:
    entry = {"file": chart.file_name, "title": chart.title, "category": chart.category}
    if pdf:
        entry["pdf"] = pdf
    if page:
        entry["page"] = page
    entry.update(result)
    return entry


def georeference_pdf(data: bytes, points) -> tuple[dict, dict]:
    """(page info, result) where result is {"georef": {...}} or
    {"unusable": reason}. Positions are fractions of the displayed page."""
    page = extract_page(data)
    info = {
        "width": round(page.width * page.points_per_pixel, 2),
        "height": round(page.height * page.points_per_pixel, 2),
        "rotation": page.rotation,
    }
    r = gr.auto_georeference(page, points)
    if isinstance(r, gr.Failure):
        return info, {"unusable": r.reason}
    geo = Georeference.fit(r.points, r.projection, conformal=r.conformal)
    corners = [(0, 0), (page.width, 0), (page.width, page.height), (0, page.height)]
    footprint = [geo.to_latlng(x, y) for x, y in corners]
    return info, {
        "georef": {
            "algorithm": gr.ALGORITHM_VERSION,
            "method": r.method,
            "projection": r.projection.id,
            "conformal": r.conformal,
            "accuracyM": round(r.rms_m, 1),
            "estimated": r.estimated,
            "points": [
                {"u": round(p.x / page.width, 6), "v": round(p.y / page.height, 6), "lat": round(p.pos.lat, 7), "lon": round(p.pos.lon, 7)}
                for p in r.points
            ],
            "footprint": [[round(c.lat, 6), round(c.lon, 6)] for c in footprint],
            "notToScale": [
                [round(b.left / page.width, 5), round(b.top / page.height, 5), round(b.right / page.width, 5), round(b.bottom / page.height, 5)]
                for b in r.not_to_scale
            ],
        }
    }


class ChartProcessor:
    def __init__(self, source: EaipSource, state: State, out: Path, mirror: str | None):
        self.source = source
        self.state = state
        self.out = out
        self.mirror = mirror
        self.stats = {"downloaded": 0, "reused": 0, "georeferenced": 0, "usable": 0, "charts": 0}

    def _fingerprint(self, chart: ChartRef) -> str | None:
        """Size and modification time from a HEAD request: a cheap way to
        tell an unchanged file without downloading it."""
        try:
            r = self.source.client.session.head(chart.url, timeout=60, allow_redirects=True)
            self.source.client.requests += 1
        except requests.RequestException:
            return None
        if r.status_code != 200:
            return None
        length, modified = r.headers.get("Content-Length"), r.headers.get("Last-Modified")
        return f"{length}|{modified}" if length and modified else None

    def _pdf_bytes(self, sha: str, chart: ChartRef) -> bytes:
        """A PDF we already know, from our own copy where possible."""
        local = self.out / "pdf" / f"{sha}.pdf"
        if local.exists():
            return local.read_bytes()
        stored = Output.publisher.get(f"pdf/{sha}.pdf")
        if stored is not None and hashlib.sha256(stored).hexdigest() == sha:
            return stored
        if self.mirror:
            r = requests.get(urljoin(self.mirror, f"pdf/{sha}.pdf"), timeout=120)
            if r.status_code == 200 and hashlib.sha256(r.content).hexdigest() == sha:
                return r.content
        return self.source.download(chart)

    def process(self, chart: ChartRef, points) -> dict:
        self.stats["charts"] += 1
        if chart.category not in MAP_CATEGORIES:
            return chart_entry(chart, None, None, {"unusable": "Table, not a map."})
        key = f"{self.source.country.id}|{chart.icao}|{chart.file_name}"
        known = self.state.files.get(key)
        fingerprint = self._fingerprint(chart)
        data = None
        if known and fingerprint and known.get("fingerprint") == fingerprint:
            sha, size = known["sha256"], known["bytes"]
            self.stats["reused"] += 1
        else:
            data = self.source.download(chart)
            self.stats["downloaded"] += 1
            sha, size = hashlib.sha256(data).hexdigest(), len(data)
            self.state.files[key] = {"fingerprint": fingerprint, "sha256": sha, "bytes": size}
        pdf_path = self.out / "pdf" / f"{sha}.pdf"
        if data is not None:
            write_pdf(pdf_path, data)

        cached = self.state.charts.get(sha)
        if cached and cached.get("algorithm") == gr.ALGORITHM_VERSION:
            page, result = cached["page"], cached["result"]
        else:
            if data is None:
                data = self._pdf_bytes(sha, chart)
            page, result = georeference_pdf(data, points)
            self.stats["georeferenced"] += 1
            # A revision counter apps compare to know their copy is stale.
            revision = (cached or {}).get("revision", 0)
            if cached is None or cached.get("result") != result:
                revision += 1
            self.state.charts[sha] = {"algorithm": gr.ALGORITHM_VERSION, "revision": revision, "page": page, "result": result}
        result = dict(result)
        if "georef" in result:
            result["georef"] = {"revision": self.state.charts[sha]["revision"], **result["georef"]}
            self.stats["usable"] += 1
        return chart_entry(chart, {"path": f"pdf/{sha}.pdf", "sha256": sha, "bytes": size}, page, result)


# --- En-route --------------------------------------------------------------


def build_enroute(source: EaipSource, edition: Edition) -> dict:
    """The airway network, in the app's EnrouteData JSON format."""
    pages = source.route_pages(edition)
    parsed, unread = [], []
    with ThreadPoolExecutor(2) as pool:
        def fetch(name):
            try:
                return parse_route_page(source.page(edition, name)), None
            except Exception as e:  # noqa: BLE001 - recorded, not fatal
                log.warning("Route page %s: %s", name, e)
                return [], name

        for n, (routes, failed) in enumerate(pool.map(fetch, pages), 1):
            parsed.extend(routes)
            if failed:
                unread.append(failed)
            if n % 100 == 0:
                log.info("  %s en-route: %d of %d route pages", edition.name, n, len(pages))

    points, index = [], {}

    def point(p):
        name, ident, pos, kind, compulsory = p
        key = f"{ident or name}|{pos.lat:.4f}|{pos.lon:.4f}"
        if key in index:
            i = index[key]
            if compulsory and not points[i].get("c"):
                points[i]["c"] = True
            return i
        entry = {"n": name, "lat": pos.lat, "lon": pos.lon, "k": kind}
        if ident:
            entry["i"] = ident
        if compulsory:
            entry["c"] = True
        index[key] = len(points)
        points.append(entry)
        return index[key]

    routes = []
    for r in parsed:
        ids = [point(p) for p in r.points]
        segs = []
        for i in range(len(ids) - 1):
            seg = {"f": ids[i], "t": ids[i + 1]}
            leg = r.legs[i] if i < len(r.legs) else {}
            seg.update({k: v for k, v in leg.items() if v is not None})
            segs.append(seg)
        route = {"id": r.designator, "seg": segs}
        if r.navigation_spec:
            route["spec"] = r.navigation_spec
        routes.append(route)
    airspace_page = source.section_page("ENR 2.1")
    try:
        airspaces = parse_airspace_page(source.page(edition, airspace_page))
    except Exception as e:  # noqa: BLE001 - recorded, not fatal
        log.warning("Airspace page %s: %s", airspace_page, e)
        airspaces = []
        unread.append(airspace_page)
    return {
        "version": 1,
        "source": source.country.id,
        "edition": edition.id,
        "editionName": edition.name,
        "points": points,
        "routes": routes,
        "airspaces": airspaces,
        "unread": unread,
    }


# --- Run -------------------------------------------------------------------


class Output:
    """The output directory, and where each file is published as soon as
    it's written."""

    root: Path = Path("out")
    publisher: Publisher = Publisher()

    @classmethod
    def publish(cls, path: Path):
        cls.publisher.put(path.relative_to(cls.root).as_posix(), path.read_bytes())


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
    tmp.replace(path)
    Output.publish(path)


def write_pdf(path: Path, data: bytes):
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    Output.publish(path)


def editions_to_publish(source: EaipSource, today: str | None = None) -> list[Edition]:
    """The edition in force and any announced after it.

    A country always has an edition in force, so a page that shows none (an
    outage, a maintenance page, a redesign) is an error, not an empty list:
    the country is skipped and its published listing stays as it was."""
    editions = source.editions()
    today = today or date.today().isoformat()
    current = [e for e in editions if e.effective <= today]
    if not current:
        found = ", ".join(f"{e.name} (from {e.effective})" for e in editions) or "none"
        raise AipError(f"{source.country.country}: no edition in force on the eAIP home page (found: {found})")
    keep = [e for e in editions if e.effective > today]
    keep.append(max(current, key=lambda e: e.effective))
    return sorted(keep, key=lambda e: e.effective)


class OutOfTime(Exception):
    """The run's time budget is used up; the next run carries on."""


def save_state(state: State, out: Path):
    write_json(out / "v1" / "state.json", {**state.to_json(), "generatedAt": datetime.now(timezone.utc).isoformat()})


def run_country(country: Country, out: Path, state: State, mirror, only, client, refresh=False, deadline=None) -> dict:
    """Builds the country's editions. Raises OutOfTime when the budget runs
    out, with progress saved in `state`."""
    source = EaipSource(country, client)
    editions = editions_to_publish(source)
    log.info("%s: editions %s", country.country, [e.name for e in editions])
    processor = ChartProcessor(source, state, out, mirror)

    def check_time():
        if deadline is not None and time.time() > deadline:
            raise OutOfTime()

    built = []
    last_save = time.time()

    def listing(extra=None):
        """Editions apps may use: complete ones; or, while the country has
        none complete yet, the one being built, so it fills in as it goes."""
        complete = [e for e in editions if f"{country.id}|{e.id}" in state.editions or e.id in built]
        shown = complete or ([extra] if extra else [])
        return {"editions": [{"id": e.id, "name": e.name, "effective": e.effective} for e in shown]}

    try:
        for edition in editions:
            done_key = f"{country.id}|{edition.id}"
            # A published edition doesn't change; skip it unless the algorithm
            # improved (or a refresh is forced), keeping daily runs to one request.
            if not only and not refresh and state.editions.get(done_key) == gr.ALGORITHM_VERSION:
                if state.enroute.get(done_key) != ENROUTE_VERSION:
                    publish_enroute(source, edition, out)
                    state.enroute[done_key] = ENROUTE_VERSION
                else:
                    log.info("%s %s: already published", country.country, edition.name)
                continue
            base = out / "v1" / country.id / edition.id
            aerodromes = source.aerodromes(edition)
            if only:
                aerodromes = [a for a in aerodromes if a in only]
            done = {} if only else state.progress.setdefault(done_key, {})
            if done:
                log.info("%s: resuming, %d of %d aerodromes already done", edition.name, len(done), len(aerodromes))
            for n, icao in enumerate(aerodromes, 1):
                if icao in done:
                    continue
                check_time()
                started = time.time()
                charts = source.charts(icao, edition)
                points = source.points(icao, edition) if charts else None
                entries = []
                with ThreadPoolExecutor(2) as pool:
                    for entry in pool.map(lambda c: _safe(processor, c, points), charts):
                        entries.append(entry)
                        if len(entries) % 25 == 0:
                            log.info("  %s: %d of %d charts (%.0fs)", icao, len(entries), len(charts), time.time() - started)
                write_json(base / "ad" / f"{icao}.json", {"schema": SCHEMA, "icao": icao, "edition": edition.id, "charts": entries})
                usable = sum(1 for e in entries if "georef" in e)
                done[icao] = {"icao": icao, "charts": len(entries), "usable": usable}
                summary = [done[a] for a in aerodromes if a in done]
                write_json(base / "aerodromes.json", {"schema": SCHEMA, "aerodromes": summary})
                if len(done) == 1 or not only:
                    write_json(out / "v1" / country.id / "editions.json", {"schema": SCHEMA, **listing(edition)})
                # Progress survives a cancelled run on a fresh machine.
                if not only and time.time() - last_save > 300:
                    save_state(state, out)
                    last_save = time.time()
                log.info("[%d/%d] %s %s: %d charts, %d usable (%.0fs)", n, len(aerodromes), edition.name, icao, len(entries), usable, time.time() - started)
            check_time()
            summary = [done[a] for a in aerodromes if a in done]
            write_json(base / "aerodromes.json", {"schema": SCHEMA, "aerodromes": summary})
            publish_enroute(source, edition, out)
            built.append(edition.id)
            if not only:
                state.editions[done_key] = gr.ALGORITHM_VERSION
                state.enroute[done_key] = ENROUTE_VERSION
                state.progress.pop(done_key, None)
    finally:
        log.info("%s: %s; %d eAIP requests", country.country, processor.stats, client.requests)
    return listing()


def publish_enroute(source: EaipSource, edition: Edition, out: Path):
    enroute = build_enroute(source, edition)
    write_json(out / "v1" / source.country.id / edition.id / "enroute.json", enroute)
    log.info(
        "%s en-route: %d routes, %d points, %d airspaces",
        edition.name, len(enroute["routes"]), len(enroute["points"]), len(enroute["airspaces"]),
    )


def _safe(processor: ChartProcessor, chart: ChartRef, points) -> dict:
    try:
        return processor.process(chart, points)
    except (AipError, requests.RequestException, ValueError) as e:
        log.warning("%s %s: %s", chart.icao, chart.file_name, e)
        return chart_entry(chart, None, None, {"unusable": f"Could not process: {e}"})


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--country", action="append", help="country id(s); default all")
    ap.add_argument("--only", help="comma-separated ICAO codes (for testing)")
    ap.add_argument("--previous", help="URL or directory of the last publication")
    ap.add_argument("--contact", help="contact address sent to eAIP servers")
    ap.add_argument("--refresh", action="store_true", help="recheck published editions for changed files")
    ap.add_argument("--max-minutes", type=float, help="stop cleanly after this long; the next run resumes")
    ap.add_argument("--publish-r2", action="store_true", help="upload each file to R2 as it's written (R2_* environment variables)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")

    Output.root = args.out
    if args.publish_r2:
        Output.publisher = R2Publisher.from_env()
    write_json(args.out / "v1" / "countries.json", {"schema": SCHEMA, "countries": [c.to_json() for c in all_countries()]})
    state, mirror = load_state(args.previous, args.out)
    client = PoliteClient(contact=args.contact)
    only = set(args.only.split(",")) if args.only else None
    countries = [c for c in all_countries() if not args.country or c.id in args.country]
    deadline = time.time() + args.max_minutes * 60 if args.max_minutes else None
    published, incomplete = [], False
    for country in countries:
        try:
            info = run_country(country, args.out, state, mirror, only, client, args.refresh, deadline)
        except OutOfTime:
            log.warning("Time budget reached; progress saved, the next run resumes.")
            incomplete = True
            break
        except (AipError, requests.RequestException) as e:
            # One country's outage mustn't stop the others; its previous
            # publication stays in place.
            log.error("%s failed: %s", country.country, e)
            continue
        published.append(country)
        # Written last: apps only see an edition once all its files exist.
        write_json(args.out / "v1" / country.id / "editions.json", {"schema": SCHEMA, **info})
    save_state(state, args.out)
    if isinstance(Output.publisher, R2Publisher):
        log.info("Published %d files to R2", Output.publisher.uploaded)
    if incomplete:
        # Tells the workflow to queue a follow-on run.
        (args.out / ".incomplete").write_text("resume\n")
        return 0
    return 0 if len(published) == len(countries) else 1


if __name__ == "__main__":
    sys.exit(main())
