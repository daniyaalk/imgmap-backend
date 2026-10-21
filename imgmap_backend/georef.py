"""Automatic georeferencing of chart pages. Ported from the app
(lib/src/georef/); see the docstrings there for the reasoning, repeated in
brief here.

Bump ALGORITHM_VERSION whenever a change can alter results: the pipeline
then redoes every chart and apps pick up the new control points.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field, replace

import numpy as np

from .eaip import PointDirectory, is_fix_name
from .geo import (
    WEB_MERCATOR,
    ControlPoint,
    Georeference,
    GeoreferenceError,
    LatLng,
    Projection,
    TransverseMercator,
)
from .pdfpage import Box, ChartPage, ChartText

ALGORITHM_VERSION = 6


@dataclass
class AutoGeoreference:
    points: list[ControlPoint]
    rms_m: float
    method: str
    projection: Projection = WEB_MERCATOR
    estimated: bool = False
    """rms_m is an allowance for an unverifiable fit, not measured."""
    conformal: bool = False
    not_to_scale: list[Box] = field(default_factory=list)
    scale_ratio: float | None = None


@dataclass
class Failure:
    reason: str


# --- Grid labels -----------------------------------------------------------


@dataclass(frozen=True)
class GridLabel:
    axis: str  # "lat" or "lon"
    value: float
    cx: float
    cy: float
    text: str


_LABEL = re.compile(
    r"""(?:([NSEW])\s*)?(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['’′]\s*(?:(\d{1,2}(?:\.\d+)?)\s*["”″]\s*)?([NSEW])?"""
)


def _compact(t: ChartText, upper=False):
    chars, index = [], []
    for i, c in enumerate(t.text):
        if c.strip():
            chars.append(c.upper() if upper else c)
            index.append(i)
    return "".join(chars), index


def not_to_scale_areas(texts: list[ChartText]) -> list[Box]:
    phrase = re.compile(r"NOT(?:DRAWN)?TOSCALE|(?<![A-Z])NTS(?![A-Z])")
    areas = []
    for t in texts:
        s, index = _compact(t, upper=True)
        for m in phrase.finditer(s):
            areas.append(t.bounds_of(index[m.start()], index[m.end() - 1] + 1))
    return areas


def find_grid_labels(texts: list[ChartText]) -> list[GridLabel]:
    """Round-valued coordinate labels: whole minutes, which keeps out the
    precise positions printed beside fixes."""
    labels = []
    for t in texts:
        s, index = _compact(t)
        for m in _LABEL.finditer(s):
            hemi = m.group(1) or m.group(5)
            if hemi is None or (m.group(1) and m.group(5)):
                continue
            deg, minute = int(m.group(2)), int(m.group(3))
            sec = float(m.group(4)) if m.group(4) else 0.0
            if minute >= 60 or sec != 0:
                continue
            axis = "lat" if hemi in "NS" else "lon"
            if deg > (90 if axis == "lat" else 180):
                continue
            if m.start() > 0 and re.match(r"[\d.]", s[m.start() - 1]):
                continue  # started mid-number
            sign = -1 if hemi in "SW" else 1
            b = t.bounds_of(index[m.start()], index[m.end() - 1] + 1)
            labels.append(GridLabel(axis, sign * (deg + minute / 60), b.cx, b.cy, m.group(0)))
    return labels


# --- Scale -----------------------------------------------------------------


@dataclass
class ChartScale:
    mpp: float
    """Ground meters per pixel."""
    source: str


def printed_scale(text: str) -> int | None:
    m = re.search(r"SCALE:?1:(\d{1,3}(?:[,.]\d{3})+|\d{4,8})(?![\d,.]*\d)", text, re.I)
    if not m:
        return None
    n = int(re.sub("[,.]", "", m.group(1)))
    return n if 1000 <= n <= 50_000_000 else None


def printed_scale_of(texts: list[ChartText]) -> int | None:
    def compact(t):
        return re.sub(r"\s+", "", t.text)

    for i, t in enumerate(texts):
        here = compact(t)
        found = printed_scale(here) or (printed_scale(here + compact(texts[i + 1])) if i + 1 < len(texts) else None)
        if found:
            return found
    return None


def scale_bar_mpp(texts: list[ChartText]) -> float | None:
    """Ground meters per pixel from a horizontal bar: 0 5 10 15 … NM."""
    ticks, units = [], []
    for t in texts:
        s = re.sub(r"\s+", "", t.text).upper()
        m = re.fullmatch(r"(\d{1,3})(NM|KM)?", s)
        if m:
            start = 0
            while not t.text[start].strip():
                start += 1
            db = t.bounds_of(start, start + len(m.group(1)))
            ticks.append((int(m.group(1)), db.cx, db.cy, db.height, m.group(2)))
        elif re.fullmatch(r"NM|KM", s):
            b = t.bounds
            units.append((b.cx, b.cy, b.height, s))
    best, best_count = None, 0
    for zero in (t for t in ticks if t[0] == 0):
        _, zx, zy, zh, _ = zero
        row = sorted((t for t in ticks if abs(t[2] - zy) < 0.6 * zh and t[1] >= zx), key=lambda t: t[1])
        run = [row[0]]
        for t in row[1:]:
            if t[0] > run[-1][0]:
                run.append(t)
        if len(run) < 3:
            continue
        last = run[-1]
        unit = last[4]
        if unit is None:
            for ux, uy, _, u in units:
                if abs(uy - zy) < 1.5 * zh and ux > zx and ux - last[1] < 0.5 * (last[1] - zx):
                    unit = u
                    break
        if unit is None:
            continue
        px_per_unit = (last[1] - zx) / last[0]
        if px_per_unit <= 0:
            continue
        span = last[1] - zx
        if not all(abs(zx + t[0] * px_per_unit - t[1]) < 0.03 * span for t in run):
            continue
        if len(run) <= best_count:
            continue
        best_count = len(run)
        best = (1852 if unit == "NM" else 1000) / px_per_unit
    return best


def chart_scale(page: ChartPage):
    """ChartScale, None, or Failure when bar and printed scale disagree (the
    chart was resized after drawing; the printed figure can't be trusted)."""
    bar = scale_bar_mpp(page.texts)
    denominator = printed_scale_of(page.texts)
    printed = denominator * 0.0254 / 72 * page.points_per_pixel if denominator else None
    if bar and printed:
        ratio = bar / printed
        if not 0.95 <= ratio <= 1.05:
            return Failure(f"Scale bar and printed 1:{denominator} disagree by {abs(round((ratio - 1) * 100))}%.")
        return ChartScale(bar, f"scale bar (matches 1:{denominator})")
    if bar:
        return ChartScale(bar, "scale bar")
    if printed:
        return ChartScale(printed, f"printed 1:{denominator}")
    return None


# --- Grid fit --------------------------------------------------------------


def _lstsq(rows, ys):
    """min |A p - y| via the normal equations; None if a direction is
    unconstrained (same relative test as the app)."""
    A = np.asarray(rows, dtype=float)
    y = np.asarray(ys, dtype=float)
    N = A.T @ A
    largest = float(np.max(np.abs(np.diag(N))))
    try:
        # Pivoted elimination mirrors the app's solver closely enough;
        # reject near-singular systems the same way.
        if largest == 0 or np.min(np.abs(np.linalg.eigvalsh(N))) < 1e-10 * largest:
            return None
        return np.linalg.solve(N, A.T @ y)
    except np.linalg.LinAlgError:
        return None


class GridFit:
    """World = a·u + b·v + c (+x0), d·u + e·v + f (+y0), with (u, v) pixels
    relative to the labels' centroid, fitted so each label lies on its line."""

    def __init__(self, projection, p, pc, x0, y0):
        self.projection = projection
        self.p = np.asarray(p, dtype=float)
        self.pc = pc
        self.x0, self.y0 = x0, y0

    @property
    def det(self):
        a, b, _, d, e, _ = self.p
        return a * e - b * d

    def latlng_of(self, xs, ys):
        a, b, c, d, e, f = self.p
        u, v = np.asarray(xs) - self.pc[0], np.asarray(ys) - self.pc[1]
        return self.projection.inverse(a * u + b * v + c + self.x0, d * u + e * v + f + self.y0)

    def pixel_of(self, p: LatLng):
        a, b, c, d, e, f = self.p
        wx, wy = self.projection.forward(p.lat, p.lon)
        x, y = float(wx) - self.x0 - c, float(wy) - self.y0 - f
        det = self.det
        return self.pc[0] + (e * x - b * y) / det, self.pc[1] + (-d * x + a * y) / det

    @property
    def mpp(self):
        lat, lon = self.latlng_of(self.pc[0], self.pc[1])
        return math.sqrt(abs(self.det)) / self.projection.scale_factor(LatLng(float(lat), float(lon)))

    @property
    def skew(self):
        a, b, _, d, e, _ = self.p
        return math.hypot(a + e, b - d) / (2 * math.sqrt(abs(self.det)))

    def residuals(self, labels) -> np.ndarray:
        xs = np.array([l.cx for l in labels])
        ys = np.array([l.cy for l in labels])
        lat, lon = self.latlng_of(xs, ys)
        is_lon = np.array([l.axis == "lon" for l in labels])
        vals = np.array([l.value for l in labels])
        dlon = (lon - vals + 540) % 360 - 180
        r_lon = np.radians(dlon) * 6371008.8 * np.cos(np.radians(lat))
        r_lat = np.radians(lat - vals) * 6371008.8
        return np.where(is_lon, r_lon, r_lat)

    @classmethod
    def solve(cls, labels, projection, start=None):
        fit = start or cls._initial(labels, projection)
        if fit is None:
            return None
        spread = _spread(labels, fit.pc)
        for _ in range(15):
            step = fit._gauss_newton(labels, spread)
            if step is None:
                return None
            fit, moved = step
            if moved < 1e-3:
                break
        return None if abs(fit.det) < 1e-18 else fit

    def _gauss_newton(self, labels, spread):
        def residuals(f):
            r = f.residuals(labels)
            prior = [0.1 * spread * (f.p[0] + f.p[4]), 0.1 * spread * (f.p[1] - f.p[3])]
            return np.concatenate([r, prior])

        r0 = residuals(self)
        s = math.sqrt(abs(self.det))
        J = np.zeros((len(r0), 6))
        for k in range(6):
            h = 1e-6 * s * (spread if k in (2, 5) else 1)
            p = self.p.copy()
            p[k] += h
            J[:, k] = (residuals(GridFit(self.projection, p, self.pc, self.x0, self.y0)) - r0) / h
        delta = _lstsq(J, -r0)
        if delta is None:
            return None
        moved = math.sqrt(
            (delta[0] * spread) ** 2 + (delta[1] * spread) ** 2 + delta[2] ** 2
            + (delta[3] * spread) ** 2 + (delta[4] * spread) ** 2 + delta[5] ** 2
        )
        return GridFit(self.projection, self.p + delta, self.pc, self.x0, self.y0), moved

    @classmethod
    def _initial(cls, labels, projection):
        """Linear Mercator solution, carried into `projection`."""
        lons = [l for l in labels if l.axis == "lon"]
        lats = [l for l in labels if l.axis == "lat"]
        if not lons or not lats:
            return None
        pc = (sum(l.cx for l in labels) / len(labels), sum(l.cy for l in labels) / len(labels))
        spread = _spread(labels, pc)
        if spread == 0:
            return None
        m = WEB_MERCATOR

        def east(lon):
            return float(m.forward(0.0, lon)[0])

        def north(lat):
            return float(m.forward(lat, 0.0)[1])

        x0 = sum(east(l.value) for l in lons) / len(lons)
        y0 = sum(north(l.value) for l in lats) / len(lats)
        rows, ys = [], []
        for l in labels:
            u, v = l.cx - pc[0], l.cy - pc[1]
            if l.axis == "lon":
                rows.append([u, v, 1, 0, 0, 0])
                ys.append(east(l.value) - x0)
            else:
                rows.append([0, 0, 0, u, v, 1])
                ys.append(north(l.value) - y0)
        w = 0.1 * spread
        rows += [[w, 0, 0, 0, w, 0], [0, w, 0, -w, 0, 0]]
        ys += [0, 0]
        p = _lstsq(rows, ys)
        if p is None:
            return None
        merc_fit = GridFit(m, p, pc, x0, y0)
        if abs(merc_fit.det) < 1e-18:
            return None
        if projection.id == m.id:
            return merc_fit

        def proj(px, py):
            lat, lon = merc_fit.latlng_of(px, py)
            x, y = projection.forward(lat, lon)
            return float(x), float(y)

        ox, oy = proj(*pc)
        exx, exy = proj(pc[0] + spread, pc[1])
        eyx, eyy = proj(pc[0], pc[1] + spread)
        return GridFit(
            projection,
            [(exx - ox) / spread, (eyx - ox) / spread, 0, (exy - oy) / spread, (eyy - oy) / spread, 0],
            pc,
            ox,
            oy,
        )


def _spread(labels, pc):
    return math.sqrt(sum((l.cx - pc[0]) ** 2 + (l.cy - pc[1]) ** 2 for l in labels) / len(labels))


def _rms(values) -> float:
    values = list(values)
    return math.sqrt(sum(v * v for v in values) / len(values))


def _trimmed_fit(labels, projection):
    """Fit, dropping the label whose removal helps most while one clearly
    disagrees (a stray coordinate in a note or inset)."""
    fit = GridFit.solve(labels, projection)
    if fit is None:
        return None
    while len(labels) > 5:
        r = np.sort(np.abs(fit.residuals(labels)))
        median = r[len(r) // 2]
        if r[-1] <= max(3 * median, 4 * fit.mpp):
            break
        best, best_i, best_rms = None, -1, math.inf
        for i in range(len(labels)):
            rest = labels[:i] + labels[i + 1:]
            f = GridFit.solve(rest, projection, start=fit)
            if f is None:
                continue
            rms = _rms(f.residuals(rest))
            if rms < best_rms:
                best, best_i, best_rms = f, i, rms
        if best is None:
            break
        labels = labels[:best_i] + labels[best_i + 1:]
        fit = best
    return fit, labels, _rms(fit.residuals(labels))


def _from_grid(labels, page: ChartPage, scale):
    mean_lon = np.mean([l.value for l in labels if l.axis == "lon"])
    mean_lat = np.mean([l.value for l in labels if l.axis == "lat"])
    candidates = [WEB_MERCATOR, *TransverseMercator.candidates(float(mean_lon), north=mean_lat >= 0)]
    best = None
    for projection in candidates:
        trimmed = _trimmed_fit(labels, projection)
        if trimmed and (best is None or trimmed[2] < best[2]):
            best = trimmed
    if best is None:
        return Failure("Grid labels don't pin the chart's position and orientation.")
    fit, labels, rms = best
    if fit.skew > 0.03:
        return Failure("Grid labels don't pin the chart's orientation.")
    if rms > 8 * fit.mpp:
        return Failure(f"Grid labels disagree by ±{round(rms)} m.")
    for i in range(len(labels)):
        rest = labels[:i] + labels[i + 1:]
        f = GridFit.solve(rest, fit.projection, start=fit)
        if f is None or abs(f.residuals([labels[i]])[0]) > 8 * fit.mpp:
            return Failure("Grid labels don't cross-check: too few, or all along one edge.")
    lats = {l.value for l in labels if l.axis == "lat"}
    lons = {l.value for l in labels if l.axis == "lon"}
    points = []
    for lat in lats:
        for lon in lons:
            x, y = fit.pixel_of(LatLng(lat, lon))
            if 0 <= x < page.width and 0 <= y < page.height:
                points.append(ControlPoint(x, y, LatLng(lat, lon)))
    if len(points) < 3:
        return Failure("Too few grid lines on the chart.")
    ratio = None
    if scale is not None:
        ratio = fit.mpp / scale.mpp
        if not 0.9 <= ratio <= 1.11:
            return Failure(f"Grid labels imply a scale {round(ratio * 100)}% of the {scale.source}.")
    return AutoGeoreference(points, rms, "grid labels", fit.projection, scale_ratio=ratio)


@dataclass
class _Line:
    px: float
    py: float
    dx: float
    dy: float
    span: float

    @classmethod
    def through(cls, labels):
        if len(labels) < 2:
            return None
        cx = sum(l.cx for l in labels) / len(labels)
        cy = sum(l.cy for l in labels) / len(labels)
        sxx = sum((l.cx - cx) ** 2 for l in labels)
        sxy = sum((l.cx - cx) * (l.cy - cy) for l in labels)
        syy = sum((l.cy - cy) ** 2 for l in labels)
        angle = 0.5 * math.atan2(2 * sxy, sxx - syy)
        dx, dy = math.cos(angle), math.sin(angle)
        ts = [(l.cx - cx) * dx + (l.cy - cy) * dy for l in labels]
        return cls(cx, cy, dx, dy, max(ts) - min(ts))

    def distance_to(self, x, y):
        return abs((x - self.px) * self.dy - (y - self.py) * self.dx)

    def intersect(self, o):
        cross = self.dx * o.dy - self.dy * o.dx
        if abs(cross) < 1e-6:
            return None
        ex, ey = o.px - self.px, o.py - self.py
        t = (ex * o.dy - ey * o.dx) / cross
        return self.px + self.dx * t, self.py + self.dy * t


def _from_single_lines(labels, page: ChartPage, scale: ChartScale):
    """One meridian and one parallel: position and rotation from the lines,
    scale from the chart's bar or printed figure."""

    def line(axis):
        groups = {}
        for l in labels:
            if l.axis == axis:
                groups.setdefault(l.value, []).append(l)
        return max(groups.values(), key=len) if groups else []

    meridian, parallel = line("lon"), line("lat")
    min_span = 0.3 * page.shortest
    m, p = _Line.through(meridian), _Line.through(parallel)
    if m is None or p is None or m.span < min_span or p.span < min_span:
        return Failure("Grid labels don't span enough of the chart.")
    north = (m.dx, m.dy) if m.dy <= 0 else (-m.dx, -m.dy)
    east = (p.dx, p.dy) if p.dx >= 0 else (-p.dx, -p.dy)
    nfe = (east[1], -east[0])
    skew = math.degrees(math.asin(max(-1.0, min(1.0, north[0] * nfe[1] - north[1] * nfe[0]))))
    if abs(skew) > 1.5:
        return Failure(f"Grid lines are {abs(skew):.1f}° from square.")
    nx, ny = north[0] + nfe[0], north[1] + nfe[1]
    nl = math.hypot(nx, ny)
    up = (nx / nl, ny / nl)
    right = (-up[1], up[0])
    origin = m.intersect(p)
    if origin is None:
        return Failure("Grid lines don't cross.")
    lat0, lon0 = parallel[0].value, meridian[0].value
    px = 0.25 * page.shortest
    dist = px * scale.mpp
    a, e2 = 6378137.0, 0.00669437999014
    s0 = math.sin(math.radians(lat0))
    w = 1 - e2 * s0 * s0
    meridional = a * (1 - e2) / (w * math.sqrt(w))
    prime_vertical = a / math.sqrt(w)
    dlat = math.degrees(dist / meridional)
    dlon = math.degrees(dist / (prime_vertical * math.cos(math.radians(lat0))))
    ox, oy = origin
    points = [
        ControlPoint(ox, oy, LatLng(lat0, lon0)),
        ControlPoint(ox + right[0] * px, oy + right[1] * px, LatLng(lat0, lon0 + dlon)),
        ControlPoint(ox - right[0] * px, oy - right[1] * px, LatLng(lat0, lon0 - dlon)),
        ControlPoint(ox + up[0] * px, oy + up[1] * px, LatLng(lat0 + dlat, lon0)),
        ControlPoint(ox - up[0] * px, oy - up[1] * px, LatLng(lat0 - dlat, lon0)),
    ]
    rms = _rms([m.distance_to(l.cx, l.cy) * scale.mpp for l in meridian] + [p.distance_to(l.cx, l.cy) * scale.mpp for l in parallel])
    if rms > 8 * scale.mpp:
        return Failure(f"Grid labels disagree by ±{round(rms)} m.")
    # Unverifiable: on real charts within ~1% of the distance from the crossing.
    farthest = max(math.hypot(cx - ox, cy - oy) for cx, cy in ((0, 0), (page.width, 0), (0, page.height), (page.width, page.height)))
    estimate = max(rms, 0.01 * farthest * scale.mpp)
    # Zone from the chart's middle: a labelled meridian is often a zone boundary.
    mid_east = ((page.width / 2 - ox) * right[0] + (page.height / 2 - oy) * right[1]) * scale.mpp
    mid_lon = lon0 + math.degrees(mid_east / (prime_vertical * math.cos(math.radians(lat0))))
    return AutoGeoreference(
        points,
        estimate,
        f"grid lines + {scale.source}",
        TransverseMercator(TransverseMercator.utm_zone(mid_lon), lat0 >= 0),
        estimated=True,
    )


def georeference_from_grid(page: ChartPage):
    nts = not_to_scale_areas(page.texts)
    labels = find_grid_labels(page.texts)
    if len(labels) < 4:
        return Failure("No grid labels found.")
    scale = chart_scale(page)
    if isinstance(scale, Failure):
        return scale
    distinct = {axis: {l.value for l in labels if l.axis == axis} for axis in ("lat", "lon")}
    if len(distinct["lat"]) >= 2 and len(distinct["lon"]) >= 2:
        result = _from_grid(labels, page, scale)
        if isinstance(result, AutoGeoreference) and nts:
            return replace(result, not_to_scale=nts)
        if isinstance(result, Failure) and nts:
            return Failure(f"Marked not to scale, and its grid didn't check out: {result.reason}")
        return result
    if nts:
        return Failure("Marked not to scale, with no full coordinate grid to rely on.")
    if scale is None:
        return Failure("Only one grid line each way and no scale to go with them.")
    return _from_single_lines(labels, page, scale)


# --- Named fixes -----------------------------------------------------------

_WORD = re.compile(r"(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,4})(?![A-Za-z0-9])")
_DESIGNATOR = re.compile(r"^\s*\d{1,2}[A-Z](?![A-Za-z])")


@dataclass
class FixCandidate:
    name: str
    symbol: Box
    positions: list[LatLng]
    label: Box


def _box_point_distance(b: Box, x, y):
    dx = max(b.left - x, 0.0, x - b.right)
    dy = max(b.top - y, 0.0, y - b.bottom)
    return math.hypot(dx, dy)


class _Symbols:
    CELL = 128.0

    def __init__(self, shapes):
        self.buckets = {}
        for s in shapes:
            aspect = s.width / max(s.height, 1e-6)
            if aspect < 0.5 or aspect > 2 or s.longest < 4:
                continue
            self.buckets.setdefault(self._key(s.cx, s.cy), []).append(s)

    def _key(self, x, y):
        return (math.floor(x / self.CELL), math.floor(y / self.CELL))

    def nearest(self, around: Box, radius, min_size, max_size, exclude=None):
        best, best_d = None, math.inf
        for kx in range(math.floor((around.left - radius) / self.CELL), math.floor((around.right + radius) / self.CELL) + 1):
            for ky in range(math.floor((around.top - radius) / self.CELL), math.floor((around.bottom + radius) / self.CELL) + 1):
                for s in self.buckets.get((kx, ky), ()):
                    if not min_size <= s.longest <= max_size:
                        continue
                    if exclude and exclude(s):
                        continue
                    d = _box_point_distance(around, s.cx, s.cy)
                    if d < best_d and d <= radius:
                        best, best_d = s, d
        return best


def find_fix_candidates(page: ChartPage, directory: PointDirectory, symbols=None):
    symbols = symbols or _Symbols(page.shapes)
    seen, found = set(), []
    for t in page.texts:
        for m in _WORD.finditer(t.text):
            name = m.group(1)
            if not is_fix_name(name) or name not in directory:
                continue
            if _DESIGNATOR.match(t.text[m.end():]):
                continue  # a procedure name (DUDUM 6E), not the fix
            label = t.bounds_of(m.start(), m.end())
            glyph = label.shortest
            if glyph <= 0:
                continue
            keep_out = label.inflate(2)
            s = symbols.nearest(label, 4.5 * glyph, 0.8 * glyph, 2.5 * glyph, exclude=keep_out.overlaps)
            if s is None:
                continue
            key = (name, round(s.cx), round(s.cy))
            if key in seen:
                continue
            seen.add(key)
            found.append(FixCandidate(name, s, directory[name], label))
    return found


def georeference_from_fixes(page: ChartPage, directory: PointDirectory, hint: Georeference | None = None, hint_radius: float = 0):
    """Consensus (RANSAC) over label-to-symbol pairs, then guided matching:
    each fix's symbol is looked for where its published position falls."""
    symbols = _Symbols(page.shapes)
    candidates = find_fix_candidates(page, directory, symbols)
    names = {c.name for c in candidates}
    if len(names) < 4:
        return Failure(f"Only {len(names)} named fix{'' if len(names) == 1 else 'es'} found.")
    tolerance = 0.004 * page.longest
    candidates.sort(key=lambda c: len(c.positions))
    pairs = [(c, p) for c in candidates for p in c.positions][:120]
    glyphs = sorted(c.label.shortest for c in candidates)
    glyph = glyphs[len(glyphs) // 2]
    lons = sorted(p.lon for _, p in pairs)
    lats = sorted(p.lat for _, p in pairs)
    mid_lon, north = lons[len(lons) // 2], lats[len(lats) // 2] >= 0
    utm = hint.projection if hint else TransverseMercator(TransverseMercator.utm_zone(mid_lon), north)

    names_arr = [c.name for c, _ in pairs]
    sym_xy = np.array([[c.symbol.cx, c.symbol.cy] for c, _ in pairs])

    def world(projection):
        return projection.forward(np.array([p.lat for _, p in pairs]), np.array([p.lon for _, p in pairs]))

    utm_world = world(utm)

    def agreeing(g: Georeference, w=utm_world):
        x, y = g.world_to_pixel(*w)
        d = np.hypot(x - sym_xy[:, 0], y - sym_xy[:, 1])
        best = {}
        for i in np.nonzero(d <= tolerance)[0]:
            n = names_arr[i]
            if n not in best or d[i] < best[n][0]:
                c, p = pairs[i]
                best[n] = (d[i], ControlPoint(c.symbol.cx, c.symbol.cy, p))
        return [v[1] for v in best.values()]

    def guided(g: Georeference, radius):
        best = {}
        for c, p in pairs:
            x, y = g.to_pixel(p)
            s = symbols.nearest(Box(x, y, x, y), radius, 0.8 * glyph, 2.5 * glyph)
            if s is None:
                continue
            d = math.hypot(s.cx - x, s.cy - y)
            if c.name not in best or d < best[c.name][0]:
                best[c.name] = (d, ControlPoint(s.cx, s.cy, p))
        return [v[1] for v in best.values()]

    min_sep = 0.15 * page.shortest
    consensus = []
    for i in range(len(pairs)):
        for j in range(i + 1, len(pairs)):
            (ca, pa), (cb, pb) = pairs[i], pairs[j]
            if ca.name == cb.name:
                continue
            if math.hypot(ca.symbol.cx - cb.symbol.cx, ca.symbol.cy - cb.symbol.cy) < min_sep:
                continue
            try:
                g = Georeference.fit(
                    [ControlPoint(ca.symbol.cx, ca.symbol.cy, pa), ControlPoint(cb.symbol.cx, cb.symbol.cy, pb)],
                    utm,
                    conformal=True,
                )
            except GeoreferenceError:
                continue
            mpp = g.meters_per_pixel
            if not 0.3 < mpp < 3000:  # charts run ~1:5,000 to 1:2,000,000
                continue
            inliers = agreeing(g)
            if len(inliers) > len(consensus):
                consensus = inliers
    if hint is not None:
        seeded = guided(hint, max(hint_radius, tolerance))
        if len(seeded) > len(consensus):
            consensus = seeded
    if len(consensus) < 3:
        return Failure(f"Named fixes don't agree ({len(consensus)} of {len(names)} consistent).")

    projections = {utm, *TransverseMercator.candidates(mid_lon, north), WEB_MERCATOR}
    fits = []
    for projection in projections:
        points, g = consensus, None
        for _ in range(5):
            try:
                g = Georeference.fit(points, projection, conformal=True)
            except GeoreferenceError:
                g = None
                break
            nxt = guided(g, tolerance)
            if len(nxt) < 3 or _same(nxt, points):
                break
            points = nxt
        if g is not None and len(g.points) >= 4:
            fits.append(g)
    if not fits:
        return Failure(f"Too few named fixes agree ({len(consensus)}).")
    most = max(len(g.points) for g in fits)
    fit = min((g for g in fits if len(g.points) >= most - 1), key=lambda g: g.rms_pixels())
    pts = fit.points

    xs, ys = [p.x for p in pts], [p.y for p in pts]
    sw, sh = max(xs) - min(xs), max(ys) - min(ys)
    if math.hypot(sw, sh) < 0.3 * math.hypot(page.width, page.height) or min(sw, sh) < 0.05 * page.shortest:
        return Failure("Agreeing fixes cover too little of the chart.")
    if fit.rms_pixels() > 0.5 * tolerance:
        return Failure("Named fixes fit loosely.")
    for i in range(len(pts)):
        rest = pts[:i] + pts[i + 1:]
        try:
            g = Georeference.fit(rest, fit.projection, conformal=True)
        except GeoreferenceError:
            return Failure("Named fixes don't cross-check.")
        x, y = g.to_pixel(pts[i].pos)
        if math.hypot(x - pts[i].x, y - pts[i].y) > 2 * tolerance:
            return Failure("Named fixes don't cross-check.")
    return AutoGeoreference(pts, fit.rms_error_m, f"{len(pts)} named fixes", fit.projection, conformal=True)


def _same(a, b):
    return len(a) == len(b) and all(any(q.pos == p.pos and q.x == p.x and q.y == p.y for q in b) for p in a)


# --- Combined --------------------------------------------------------------


def auto_georeference(page: ChartPage, points: PointDirectory):
    """Grid first; named fixes confirm a full grid (or the chart is refused),
    replace a one-line estimate, or stand alone when there's no grid."""
    grid = georeference_from_grid(page)
    hint, hint_radius = None, 0.0
    if isinstance(grid, AutoGeoreference) and grid.estimated:
        hint = Georeference.fit(grid.points, grid.projection)
        hint_radius = 1.5 * grid.rms_m / hint.meters_per_pixel
    fixes = Failure("No AIP points to match.") if len(points) == 0 else georeference_from_fixes(page, points, hint, hint_radius)

    if isinstance(grid, AutoGeoreference) and isinstance(fixes, AutoGeoreference):
        grid_geo = Georeference.fit(grid.points, grid.projection)
        gap = 0.0
        for p in fixes.points:
            x, y = grid_geo.to_pixel(p.pos)
            gap = max(gap, math.hypot(x - p.x, y - p.y) * grid_geo.meters_per_pixel)
        allowed = grid.rms_m * 1.5 if grid.estimated else max(4 * grid.rms_m, 3 * fixes.rms_m) + 8 * grid_geo.meters_per_pixel
        if gap > allowed:
            return Failure(f"Grid and named fixes disagree by {round(gap)} m.")
        n = len(fixes.points)
        if grid.estimated:
            return replace(fixes, method=f"{n} named fixes, agreeing with the grid", not_to_scale=grid.not_to_scale)
        return replace(grid, method=f"{grid.method}, confirmed by {n} fixes")
    if isinstance(grid, AutoGeoreference):
        return grid
    if isinstance(fixes, AutoGeoreference):
        return replace(fixes, not_to_scale=not_to_scale_areas(page.texts))
    return Failure(f"{grid.reason} {fixes.reason}")
