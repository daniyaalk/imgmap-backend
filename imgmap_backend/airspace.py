"""Airspace from an eAIP's ENR 2.1: FIRs, control areas, TMAs and control
zones, with their lateral and vertical limits and the ATS units (call
signs and frequencies) serving them.

Each table row describes one airspace in its first cell (name, lateral
limits, vertical limits, class) beside one unit; further units follow in
rows of their own.
"""

from __future__ import annotations

import math
import re

from .eaip import node_text, parse_html
from .geo import EARTH_RADIUS_M, LatLng

_KINDS = (
    (re.compile(r"flight information|\bFIR\b|\bUIR\b", re.I), "fir"),
    (re.compile(r"terminal|\bTMA\b", re.I), "tma"),
    (re.compile(r"control zone|\bCTR\b", re.I), "ctr"),
    (re.compile(r"control area|\bCTA\b", re.I), "cta"),
)
_SECTION = re.compile(r"^\s*\d+\.\d+\.\d+\s+(.+)")

# 1800N 07600E, 250000N 0705500E, 262702N 0903949.0E, and the odd
# longitude missing its leading zero (174304N 775356E).
_COORD = re.compile(r"(?<![\d.])(\d{4}(?:\d{2})?(?:\.\d+)?)\s*([NS])[\s,]*(\d{4,7}(?:\.\d+)?)\s*([EW])")
# "centred on 1234N...", "centred on ARP VOML (125743N 0745323E)"
_CENTRE_BEFORE = re.compile(
    r"(?:cent(?:er|re|red|ered)|around)\s*(?:at|on)?\s*(?:the\s+)?(?:point\s+)?(?:ARP\s+)?(?:[A-Z]{4}\s*)?\(?\s*$", re.I
)
_ARC = re.compile(r"\barc\b", re.I)
_RADIUS = re.compile(r"(\d+(?:\.\d+)?)\s*NM", re.I)
_ANNULUS = re.compile(r"between\s+(?:(?:the\s+)?circles?\s+of\s+)?(\d+(?:\.\d+)?)\s*(?:NM)?\s*(?:and|to)\s*(\d+(?:\.\d+)?)\s*NM", re.I)
# Boundaries we can't draw from coordinates; the polygon cuts straight across.
_NOT_DRAWN = re.compile(r"border|boundar|coast|ARP of", re.I)
# Where the lateral limits end and the vertical limits or classification begin.
_LATERAL_END = re.compile(
    r"•|\bUNL\b|\bFL\s*\d|\bclassified\b|vertical limit|\d\s*(?:FT|ft)\b|\bSFC\b|\bGND\b"
)
_NAME_END = re.compile(
    r"\b(?:area\s+bounded|area\s+bound\b|circular\s+area|beginning|airspace\s+bound|encompassing|semi\s+circle)"
    r"|\d{4,6}(?:\.\d+)?\s*[NS]\b",
    re.I,
)

_LEVEL = r"(?:FL\s*\d{2,3}|UNL|GND|SFC|MSL|\d[\d ]{0,6}\s*FT(?:\s*(?:AMSL|AGL|MSL|ALT))?)"
_LEVELS = re.compile(rf"({_LEVEL})\s*/\s*({_LEVEL})", re.I)
_UPPER = re.compile(rf"({_LEVEL})(?=\W*(?:[A-G])?\s*$)", re.I)
_CLASS_AFTER = re.compile(r"^\W*([A-G])\b")
_CLASS = re.compile(r"\bclass(?:ified as)?\s*(?:class\s*)?['‘’\"]?\s*([A-G])\b", re.I)

_VHF = re.compile(r"(?<![\d.])(1[0-3]\d\.\d{1,3}|1[0-3]\d(?=\s*MHZ))(?![\d.])", re.I)
_HF = re.compile(r"(?<![\d.])(\d{4,5})\s*KHZ", re.I)
_LANGUAGE = re.compile(r"^(.*?)\s*\b(?:English|Hindi|French|Spanish)\b(?:\s*/\s*\w+)*\s*(.*)$", re.I)


def _dms(digits: str, degree_digits: int) -> float | None:
    whole, _, fraction = digits.partition(".")
    if len(whole) in (4, 6) and degree_digits == 3:
        whole = "0" + whole  # degrees under 100 written without the zero
    d, m, s = whole[:degree_digits], whole[degree_digits:degree_digits + 2], whole[degree_digits + 2:]
    if len(m) != 2 or len(s) not in (0, 2):
        return None
    sec = float(s + ("." + fraction if fraction else "")) if s else 0
    if int(m) >= 60 or sec >= 60:
        return None
    return int(d) + int(m) / 60 + sec / 3600


def _latlng(m: re.Match) -> LatLng | None:
    lat, lon = _dms(m.group(1), 2), _dms(m.group(3), 3)
    if lat is None or lon is None or lat > 90 or lon > 180:
        return None
    return LatLng(-lat if m.group(2) == "S" else lat, -lon if m.group(4) == "W" else lon)


# --- Geometry ----------------------------------------------------------------


def _destination(c: LatLng, bearing: float, distance_m: float) -> LatLng:
    d = distance_m / EARTH_RADIUS_M
    b = math.radians(bearing)
    lat1, lon1 = math.radians(c.lat), math.radians(c.lon)
    lat2 = math.asin(math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(b))
    lon2 = lon1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(lat1), math.cos(d) - math.sin(lat1) * math.sin(lat2))
    return LatLng(math.degrees(lat2), (math.degrees(lon2) + 540) % 360 - 180)


def circle(c: LatLng, radius_nm: float, step: float = 5) -> list[LatLng]:
    return [_destination(c, a, radius_nm * 1852) for a in _frange(0, 360, step)]


def _frange(start, stop, step):
    n = max(1, round(abs(stop - start) / step))
    return [start + (stop - start) * i / n for i in range(n)]


def arc(start: LatLng, end: LatLng, c: LatLng, radius_nm: float | None, clockwise: bool | None, step: float = 5) -> list[LatLng] | None:
    """Points strictly between [start] and [end] along a circle about [c],
    or None when the points don't lie on it (a misprint we shouldn't
    draw)."""
    r1, r2 = c.distance_to(start), c.distance_to(end)
    r = radius_nm * 1852 if radius_nm else (r1 + r2) / 2
    if abs(r1 - r) > 0.15 * r + 1852 or abs(r2 - r) > 0.15 * r + 1852:
        return None
    b1, b2 = c.bearing_to(start), c.bearing_to(end)
    sweep = (b2 - b1) % 360  # clockwise
    if clockwise is None:
        clockwise = sweep <= 180
    if not clockwise:
        sweep -= 360
    if abs(sweep) < 1e-6:
        sweep = 360 if clockwise else -360  # a full circle back to the start
    return [_destination(c, b1 + a, r) for a in _frange(0, sweep, step)[1:]]


def parse_boundary(text: str) -> tuple[list[list[LatLng]], bool]:
    """Rings (an outer one, then any holes) from lateral limits text, and
    whether the drawing is approximate (a border or a misprint drawn as a
    straight line)."""
    coords = []
    for m in _COORD.finditer(text):
        p = _latlng(m)
        if p is None:
            continue
        centre = _CENTRE_BEFORE.search(text[max(0, m.start() - 40):m.start()]) is not None
        coords.append((m.start(), m.end(), p, centre))
    arcs = [m.start() for m in _ARC.finditer(text)]
    approx = False

    points: list[LatLng] = []
    pending = None  # (text position of the arc, its centre, or None)
    last_end = 0
    for start, end, p, is_centre in coords:
        while arcs and arcs[0] < start:
            pending = [arcs.pop(0), None]
        if is_centre:
            if pending is not None:
                pending[1] = p
            continue
        between = text[last_end:start]
        if pending is not None and points:
            approx |= not _join_arc(points, p, pending, text[pending[0]:start])
        elif _NOT_DRAWN.search(between):
            approx = True
        pending = None
        last_end = end
        if not points or points[-1] != p:
            points.append(p)
    while arcs and pending is None:
        pending = [arcs.pop(0), None]
    if pending is not None and points:
        # "... then along the arc ... to the point of origin."
        if pending[1] is None:
            centres = [p for s, _, p, c in coords if c and s > pending[0]]
            pending[1] = centres[0] if centres else None
        approx |= not _join_arc(points, points[0], pending, text[pending[0]:])
    elif points and _NOT_DRAWN.search(text[last_end:]):
        approx = True
    if len(points) > 1 and points[-1] == points[0]:
        points.pop()

    if len(points) >= 3:
        return [points], approx
    centres = [p for _, _, p, c in coords if c]
    if len(points) == 1 and not centres and re.search(r"circ", text, re.I):
        centres = points  # "circle of 25 NM radius 214516N 0721126E"
    if not centres:
        return [], approx
    c = centres[0]
    if m := _ANNULUS.search(text):
        inner, outer = sorted((float(m.group(1)), float(m.group(2))))
        return [circle(c, outer), circle(c, inner)], approx
    if m := _RADIUS.search(text):
        return [circle(c, float(m.group(1)))], approx
    return [], approx


def _join_arc(points: list[LatLng], end: LatLng, pending, phrase: str) -> bool:
    """Appends the arc from points[-1] to [end]; False if it couldn't be
    drawn and a straight line stands in."""
    centre = pending[1]
    if centre is None:
        return False
    low = phrase.lower()
    clockwise = None
    if re.search(r"(counter|anti)[\s-]*clock", low):
        clockwise = False
    elif "clockwise" in low:
        clockwise = True
    r = _RADIUS.search(phrase)
    between = arc(points[-1], end, centre, float(r.group(1)) if r else None, clockwise)
    if between is None:
        return False
    points.extend(between)
    return True


# --- Levels and units ---------------------------------------------------------


def level_ft(level: str) -> int | None:
    """A level in feet (FL 145 = 14500); None for unlimited."""
    s = re.sub(r"\s+", "", level.upper())
    if s.startswith("FL"):
        return int(s[2:]) * 100
    if s in ("UNL",):
        return None
    if s in ("GND", "SFC", "MSL"):
        return 0
    m = re.match(r"(\d+)FT", s)
    return int(m.group(1)) if m else None


def _norm_level(level: str) -> str:
    s = re.sub(r"\s+", " ", level.strip().upper())
    s = re.sub(r"^FL\s*0*(\d+)", lambda m: f"FL {int(m.group(1)):03d}", s)
    s = re.sub(r"(\d)\s+(\d)", r"\1\2", s)
    return re.sub(r"(\d)\s*FT", r"\1 FT", s)


def frequencies_khz(text: str) -> list[int]:
    found = []
    for m in sorted([*_VHF.finditer(text), *_HF.finditer(text)], key=lambda m: m.start()):
        if m.re is _VHF:
            f = round(float(m.group(1)) * 1000)
            if not 108000 <= f <= 137000:
                continue
        else:
            f = int(m.group(1))
            if not 2000 <= f <= 30000:
                continue
        if f not in found:
            found.append(f)
    return found


def _unit(cells: list[str]) -> dict | None:
    name = cells[0].strip(" -")
    freqs = frequencies_khz(cells[2]) if len(cells) > 2 else []
    if not name and not freqs:
        return None
    unit = {"n": name, "f": freqs}
    if len(cells) > 1 and (m := _LANGUAGE.match(cells[1])):
        if callsign := m.group(1).strip(" -/"):
            unit["cs"] = callsign
        if hours := m.group(2).strip():
            unit["h"] = hours
    elif len(cells) > 1 and cells[1].strip(" -"):
        unit["cs"] = cells[1].strip(" -")
    return unit


def _name(cell, text: str) -> str:
    bold = next((node_text(e) for e in cell.iter("em", "strong", "b") if node_text(e)), "")
    m = _NAME_END.search(text)
    plain = text[: m.start()] if m else text[:60]
    # The bold part is the name, unless it's only the start of it (a
    # "Chennai Control Area-" heading followed by "Sector OCH").
    name = plain if len(plain) > len(bold) and plain.startswith(bold.rstrip(" -")) else bold or plain
    return re.sub(r"\s+", " ", name).strip(" -:,")


def _airspace(cell, kind: str) -> dict | None:
    text = node_text(cell)
    name = _name(cell, text)
    if not name:
        return None
    rest = text[text.find(name) + len(name):] if name in text else text
    end = _LATERAL_END.search(rest)
    rings, approx = parse_boundary(rest[: end.start()] if end else rest)
    entry: dict = {"n": name, "k": kind}
    if rings:
        entry["rings"] = [[[round(p.lat, 4), round(p.lon, 4)] for p in ring] for ring in rings]
    if approx:
        entry["approx"] = True
    # The table's own summary ("FL 460 / FL 255 D") closes the cell.
    pairs = list(_LEVELS.finditer(text))
    cls = None
    if pairs:
        last = pairs[-1]
        upper, lower = _norm_level(last.group(1)), _norm_level(last.group(2))
        cls = _CLASS_AFTER.match(text[last.end():])
    elif last := _UPPER.search(text):
        # Only an upper limit ("FL 150 D"), as for control zones.
        upper, lower = _norm_level(last.group(1)), None
        cls = _CLASS_AFTER.match(text[last.end():])
    else:
        upper = lower = None
    if upper and lower and upper.startswith("FL") and (m := re.fullmatch(r"(\d{2,3}) FT( AMSL)?", lower)):
        # A misprinted flight level ("FL 255 / 155FT AMSL"): no lower limit
        # sits a few hundred feet above sea level under a flight level.
        lower = f"FL {int(m.group(1)):03d}"
    if upper:
        entry["u"] = upper
        if (u := level_ft(upper)) is not None:
            entry["uft"] = u
    if lower:
        entry["l"] = lower
        if (l := level_ft(lower)) is not None:
            entry["lft"] = l
    if cls:
        entry["cls"] = cls.group(1).upper()
    elif len(classes := {m.group(1).upper() for m in _CLASS.finditer(text)}) == 1:
        # FIRs mix classes (D inside controlled airspace, E on routes, G
        # elsewhere); only a single one is worth showing.
        entry["cls"] = classes.pop()
    entry["units"] = []
    return entry


def parse_airspace_page(page: str) -> list[dict]:
    """Airspaces in the app's EnrouteData JSON form."""
    airspaces: list[dict] = []
    kind = "cta"
    for table in parse_html(page).iter("table"):
        rows = [[c for c in tr if isinstance(c.tag, str)] for tr in table.iter("tr")]
        rows = [r for r in rows if r]
        if not rows:
            continue
        first = node_text(rows[0][0])
        if len(rows) <= 2 and (m := _SECTION.match(first)):
            for pattern, k in _KINDS:
                if pattern.search(m.group(1)):
                    kind = k
                    break
            continue
        header = [node_text(c).lower() for c in rows[0]]
        if not header or "lateral" not in header[0] or not any("frequen" in h for h in header):
            continue
        columns = len(header)
        current = None
        for cells in rows[1:]:
            texts = [node_text(c) for c in cells]
            if len(cells) >= columns:
                current = _airspace(cells[0], kind)
                if current is None:
                    continue
                airspaces.append(current)
                unit_cells = texts[1:4]
            elif current is not None:
                unit_cells = texts[:3]
            else:
                continue
            if unit := _unit(unit_cells):
                current["units"].append(unit)
    return airspaces
