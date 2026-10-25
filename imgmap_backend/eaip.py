"""Reading Eurocontrol-style eAIPs: pages, point lists, chart indexes and
ATS routes. Ported from the app (lib/src/aip/, lib/src/enroute/)."""

from __future__ import annotations

import functools
import logging
import re
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, unquote, urljoin

import certifi
import lxml.html
import requests

from .geo import LatLng

USER_AGENT = "ImgMap-backend/1.0 (chart cache; once per AIRAC cycle)"
log = logging.getLogger("eaip")


class AipError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@functools.cache
def ca_bundle() -> str:
    """certifi's roots plus the intermediates some eAIP servers don't send
    (intermediates.pem), as a file for requests' verify."""
    pem = Path(certifi.where()).read_text() + (Path(__file__).parent / "intermediates.pem").read_text()
    with tempfile.NamedTemporaryFile("w", suffix=".pem", prefix="imgmap-ca-", delete=False) as f:
        f.write(pem)
    return f.name


class PoliteClient:
    """HTTP for a public service we must not burden: few requests at a time,
    a pause between them, and retries with backoff."""

    def __init__(self, max_parallel: int = 2, pause: float = 0.25, contact: str | None = None):
        self.session = requests.Session()
        ua = USER_AGENT + (f"; {contact}" if contact else "")
        self.session.headers["User-Agent"] = ua
        self.session.verify = ca_bundle()
        self._slots = threading.Semaphore(max_parallel)
        self._pause = pause
        self.requests = 0

    def get(self, url: str) -> requests.Response:
        for attempt in range(4):
            with self._slots:
                try:
                    r = self.session.get(url, timeout=60)
                    self.requests += 1
                except requests.RequestException as e:
                    err = AipError(f"Could not reach {url}: {e}")
                else:
                    if r.status_code == 200:
                        time.sleep(self._pause)
                        return r
                    err = AipError(f"{url} returned {r.status_code}", r.status_code)
                    if r.status_code == 404:
                        raise err
                time.sleep(self._pause)
            # Visible in the run log: throttling or blocking shows up here.
            log.warning("Retrying (attempt %d of 4): %s", attempt + 2, err)
            time.sleep(2**attempt)
        raise err

    def text(self, url: str) -> str:
        r = self.get(url)
        # eAIP pages often omit a charset; they're UTF-8.
        return r.content.decode("utf-8", errors="replace")


# --- Text from eAIP HTML ---------------------------------------------------

_BLOCK_TAGS = {
    "td", "th", "tr", "table", "tbody", "thead", "p", "div", "br", "li",
    "ul", "ol", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6", "section",
}


def node_text(node) -> str:
    """The current text of an eAIP node.

    Amended text is published as the old value in <del> beside the new in
    <ins>; only the new is kept, or an old latitude could pair with a new
    longitude. Block elements are separated by spaces; inline ones aren't,
    so an amended number (94 . 6) stays whole.
    """
    parts: list[str] = []

    def collect(n):
        tag = n.tag if isinstance(n.tag, str) else ""
        if tag == "del" or "Deleted" in (n.get("class") or ""):
            if n.tail:
                parts.append(n.tail)
            return
        block = tag.lower() in _BLOCK_TAGS
        if block:
            parts.append(" ")
        if n.text and isinstance(n.tag, str):
            parts.append(n.text)
        for child in n:
            collect(child)
        if block:
            parts.append(" ")
        if n.tail:
            parts.append(n.tail)

    if node.text:
        parts.append(node.text)
    for child in node:
        collect(child)
    return re.sub(r"\s+", " ", "".join(parts).replace(" ", " ")).strip()


def parse_html(page: str):
    return lxml.html.fromstring(page)


# --- Named points ----------------------------------------------------------

_NOT_NAMES = set("""
VOR DME DVOR NDB ILS LOC GP TACAN VORTAC MHZ KHZ GHZ H24 HJ HN HO HX FT M NM
NOTAM ATS AIP RWY THR TWY AD ARP AMSL ELEV AND OF THE TO FROM AT ON IN BY FOR
WITH TOP TANK MAST TOWER POLE ANT BLDG TREE HILL DEG MAG TRUE EGM WGS N S E W
NE NW SE SW CH X Y IAF IF FAF MAPT FAP SDF NIL NORTH SOUTH EAST WEST ABEAM
NEAR CNTR END APRON PAPI VASI ALS RVR SMR WDI LDI ATC TWR APP FIRE GND UNL FL
MSL AGL DIST NOTE CAT II III REF POS LAT LONG COORD PSN AREA ZONE MAX MIN KIAS
IAS GS AAI RADAR INDIA DELHI MSA TA TL VAR BRG ALT HDG TRK CTR CTA TMA
""".split())

_COORDS = re.compile(
    r"(\d{2})(\d{2})(\d{2}(?:\.\d+)?)\s*([NS])\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)\s*([EW])"
)
_NAME = re.compile(r"(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,4})(?![A-Za-z0-9])")


def is_fix_name(word: str) -> bool:
    """A five-letter name (DUDUM), a navaid ident (DPN), or a terminal
    waypoint code (DP421) — not a flight level (FL100)."""
    if word in _NOT_NAMES:
        return False
    return bool(
        re.fullmatch(r"[A-Z]{5}", word)
        or re.fullmatch(r"[A-Z]{2,3}", word)
        or (re.fullmatch(r"[A-Z]{2}[0-9]{3}", word) and not word.startswith("FL"))
    )


def coords_to_latlng(m: re.Match) -> LatLng | None:
    la_d, la_m, la_s = int(m.group(1)), int(m.group(2)), float(m.group(3))
    lo_d, lo_m, lo_s = int(m.group(5)), int(m.group(6)), float(m.group(7))
    if la_d > 90 or lo_d > 180 or la_m >= 60 or lo_m >= 60 or la_s >= 60 or lo_s >= 60:
        return None
    lat = la_d + la_m / 60 + la_s / 3600
    lon = lo_d + lo_m / 60 + lo_s / 3600
    return LatLng(-lat if m.group(4) == "S" else lat, -lon if m.group(8) == "W" else lon)


class PointDirectory:
    """Names to every position published under them."""

    def __init__(self):
        self.points: dict[str, list[LatLng]] = {}

    def add(self, name: str, pos: LatLng):
        lst = self.points.setdefault(name, [])
        if not any(p.distance_to(pos) < 50 for p in lst):
            lst.append(pos)

    def merge(self, other: PointDirectory):
        for name, lst in other.points.items():
            for p in lst:
                self.add(name, p)

    def __contains__(self, name):
        return name in self.points

    def __getitem__(self, name):
        return self.points.get(name, [])

    def __len__(self):
        return len(self.points)


def parse_point_page(page: str) -> PointDirectory:
    """Every DDMMSS.ssN DDDMMSS.ssE position on a page, named by the last
    two name-like words before it (a waypoint list's name, or a navaid
    table's ident and station name)."""
    text = node_text(parse_html(page))
    directory = PointDirectory()
    previous_end = 0
    for m in _COORDS.finditer(text):
        pos = coords_to_latlng(m)
        if pos is not None:
            before = text[max(m.start() - 140, previous_end):m.start()]
            names = [n.group(1) for n in _NAME.finditer(before) if is_fix_name(n.group(1))]
            for name in names[-2:]:
                directory.add(name, pos)
        previous_end = m.end()
    return directory


# --- Chart descriptions ----------------------------------------------------

CATEGORIES = ["aerodrome", "parking", "ground", "departure", "arrival", "approach", "terrain", "tabular", "other"]
MAP_CATEGORIES = set(CATEGORIES) - {"tabular"}


def describe_chart_by_name(icao: str, file_name: str) -> tuple[str, str]:
    """(title, category) from common ICAO chart abbreviations."""
    stem = re.sub(r"\.pdf$", "", file_name, flags=re.I)
    if stem.upper().startswith(icao + "-"):
        stem = stem[len(icao) + 1:]
    u = stem.upper()

    def has(p):
        return re.search(p, u) is not None

    if has(r"(^|[-_ ])(TABLE|CODING)([-_ ]|\d|$)"):
        cat = "tabular"
    elif has(r"(^|[-_ ])SID\b"):
        cat = "departure"
    elif has(r"(^|[-_ ])STAR\b"):
        cat = "arrival"
    elif has(r"(^|[-_ ])(ADC|AD[-_ ]?CHART)\b"):
        cat = "aerodrome"
    elif has(r"(^|[-_ ])(PDC|APDC)\b"):
        cat = "parking"
    elif has(r"(^|[-_ ])(GMC|TWY|LVP)\b"):
        cat = "ground"
    elif has(r"(^|[-_ ])(AOC|PATC|TATFP|ATCSMAC|MSA)"):
        cat = "terrain"
    elif has(r"(^|[-_ ])(IAC|ILS|LOC|VOR|NDB|RNP|RNAV|GLS|DME|VAC)"):
        cat = "approach"
    else:
        cat = "other"
    return re.sub(r"[-_]", " ", stem), cat


# --- Editions, charts, routes ----------------------------------------------


@dataclass(frozen=True)
class Edition:
    id: str
    name: str
    effective: str
    """ISO date, UTC."""
    base_url: str


@dataclass
class ChartRef:
    icao: str
    file_name: str
    title: str
    category: str
    url: str


@dataclass
class ParsedRoute:
    designator: str
    navigation_spec: str | None
    points: list = field(default_factory=list)
    """(name, ident, LatLng, kind, compulsory)"""
    legs: list = field(default_factory=list)
    """dicts with track, distance, upper, lower, class, moca, width"""


_HEADER = re.compile(r"^([A-Z]{1,2}\d{1,4}[A-Z]?)\b\s*(?:\(((?:RNAV|RNP)\s*[\d.]+)\))?")
_POINT = re.compile(
    r"^(.*?)\s*(\d{2})(\d{2})(\d{2}(?:\.\d+)?)\s*([NS])\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)\s*([EW])"
)
_IDENT = re.compile(r"\(([A-Z]{2,4})\)")
_NAVAID = re.compile(r"\b(VOR|DVOR|DME|NDB|TACAN|VORTAC)\b")
_TRACK = re.compile(r"\b(\d{3})\s*/\s*(?:\d{3}|-)")
_DIST = re.compile(r"([\d.]+)\s*NM\b")
_LEVEL = re.compile(r"\b(FL\s*\d{2,3}|UNL|GND|\d{3,5}\s*FT(?:\s*(?:AMSL|ALT))?)")
_CLASS = re.compile(r"\bClass\s+([A-G])\b")
_MOCA = re.compile(r"(\d{3,5})\s*FT\s*$")


def _point_latlng(m: re.Match) -> LatLng | None:
    la_d, la_m, la_s = int(m.group(2)), int(m.group(3)), float(m.group(4))
    lo_d, lo_m, lo_s = int(m.group(6)), int(m.group(7)), float(m.group(8))
    if la_d > 90 or lo_d > 180 or la_m >= 60 or lo_m >= 60 or la_s >= 60 or lo_s >= 60:
        return None
    lat = la_d + la_m / 60 + la_s / 3600
    lon = lo_d + lo_m / 60 + lo_s / 3600
    return LatLng(-lat if m.group(5) == "S" else lat, -lon if m.group(9) == "W" else lon)


def parse_route_page(page: str) -> list[ParsedRoute]:
    """Routes on an ENR 3.x page: a header row (A474 (DPN-MURUS)), then
    point rows alternating with leg rows."""
    routes: list[ParsedRoute] = []
    current: ParsedRoute | None = None
    for row in parse_html(page).iter("tr"):
        cells = [node_text(c) for c in row if isinstance(c.tag, str)]
        if all(not c for c in cells):
            continue
        joined = " | ".join(c for c in cells if c)
        h = _HEADER.match(joined) if len(cells) <= 3 else None
        if h and not _POINT.search(joined):
            current = ParsedRoute(h.group(1), h.group(2))
            routes.append(current)
            continue
        if current is None:
            continue
        point_cell = next((c for c in cells if _POINT.match(c)), "")
        if point_cell:
            m = _POINT.match(point_cell)
            pos = _point_latlng(m)
            if pos is None:
                continue
            label = m.group(1).strip()
            ident_m = _IDENT.search(label)
            ident = ident_m.group(1) if ident_m else None
            name = re.sub(r"\s+", " ", _IDENT.sub("", label)).strip()
            if current.points and current.points[-1][2] == pos:
                continue  # a repeated point at a page break
            while len(current.legs) < len(current.points):
                current.legs.append({})
            current.points.append((
                name or ident or "?",
                ident,
                pos,
                "navaid" if _NAVAID.search(label) else "waypoint",
                cells[0].strip() == "p",
            ))
            continue
        t = _TRACK.search(joined)
        d = _DIST.search(cells[2] if len(cells) > 2 else joined)
        if (t or d) and current.points and len(current.legs) < len(current.points):
            limits = cells[3] if len(cells) > 3 else ""
            levels = [re.sub(r"\s+", " ", x.group(1)) for x in _LEVEL.finditer(limits)]
            width = _DIST.search(cells[4]) if len(cells) > 4 else None
            moca = _MOCA.search(limits)
            cls = _CLASS.search(limits)
            current.legs.append({
                "trk": int(t.group(1)) if t else None,
                "d": _float(d.group(1)) if d else None,
                "u": levels[0] if levels else None,
                "l": levels[1] if len(levels) > 1 else None,
                "cls": cls.group(1) if cls else None,
                "moca": int(moca.group(1)) if moca else None,
                "w": _float(width.group(1)) if width else None,
            })
    return [r for r in routes if len(r.points) >= 2]


def _float(s):
    try:
        return float(s)
    except ValueError:
        return None


class EaipSource:
    """One country's eAIP, as described by its config."""

    def __init__(self, country, client: PoliteClient):
        self.country = country
        self.client = client
        self._shared_points: dict[str, PointDirectory] = {}

    def editions(self) -> list[Edition]:
        return self.country.find_editions(self.client)

    def _folder(self, edition: Edition) -> str:
        return urljoin(edition.base_url, "eAIP/")

    def page_url(self, edition: Edition, name: str) -> str:
        return urljoin(self._folder(edition), quote(name))

    def page(self, edition: Edition, name: str) -> str:
        return self.client.text(self.page_url(edition, name))

    def _section(self, section: str) -> str:
        return f"{self.country.page_prefix}{section}-{self.country.language}.html"

    def aerodromes(self, edition: Edition) -> list[str]:
        """ICAO codes with an AD 2 entry in the eAIP menu."""
        menu = self.page(edition, f"Menu-{self.country.language}.html")
        found = re.findall(r"AD 2\.1([A-Z]{4})-" + re.escape(self.country.language), menu)
        return sorted({icao for icao in found if self.country.covers(icao)})

    def charts(self, icao: str, edition: Edition) -> list[ChartRef]:
        seen, charts = set(), []
        for index_page in self.country.chart_index_pages(icao):
            page_url = self.page_url(edition, index_page)
            try:
                body = self.client.text(page_url)
            except AipError as e:
                if e.status == 404:
                    continue
                raise
            for a in parse_html(body).iter("a"):
                href = (a.get("href") or "").strip()
                if not href.lower().endswith(".pdf"):
                    continue
                file_name = unquote(href.split("/")[-1])
                if file_name in seen:
                    continue
                seen.add(file_name)
                title, cat = self.country.describe_chart(icao, file_name)
                charts.append(ChartRef(icao, file_name, title, cat, urljoin(page_url, quote(href, safe="/"))))
        return charts

    def download(self, chart: ChartRef) -> bytes:
        data = self.client.get(chart.url).content
        if not data.startswith(b"%PDF-"):
            raise AipError(f"{chart.file_name} is not a PDF.")
        return data

    def points(self, icao: str, edition: Edition) -> PointDirectory:
        """En-route waypoints and navaids, plus the aerodrome's own points."""
        if edition.id not in self._shared_points:
            shared = PointDirectory()
            for section in ("ENR 4.4", "ENR 4.1"):
                shared.merge(self._points_page(edition, self._section(section)))
            self._shared_points[edition.id] = shared
        result = PointDirectory()
        result.merge(self._shared_points[edition.id])
        result.merge(self._points_page(edition, self._section(f"AD 2.1{icao}")))
        return result

    def _points_page(self, edition, name) -> PointDirectory:
        try:
            return parse_point_page(self.page(edition, name))
        except AipError as e:
            if e.status == 404:
                return PointDirectory()
            raise

    def route_pages(self, edition: Edition) -> list[str]:
        menu = self.page(edition, f"Menu-{self.country.language}.html")
        links = re.findall(r"""href=['"]([^'"]*ENR 3\.\d+(?:\.\d+)?[A-Z]{1,2}\d+[A-Z]?-[^'"]*\.html)['"]""", menu)
        return sorted({unquote(link) for link in links})
