"""Positions, projections and the chart transform.

Ported from the app (lib/src/geo/) so both sides agree exactly: the app
refits the control points the backend publishes, in the same projection,
with the same maths.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

EARTH_RADIUS_M = 6371008.8


@dataclass(frozen=True)
class LatLng:
    lat: float
    lon: float

    def distance_to(self, other: LatLng) -> float:
        """Great-circle distance in meters."""
        lat1, lat2 = math.radians(self.lat), math.radians(other.lat)
        dlat = lat2 - lat1
        dlon = math.radians(other.lon - self.lon)
        h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
        return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))

    def bearing_to(self, other: LatLng) -> float:
        """Initial great-circle bearing, degrees true."""
        lat1, lat2 = math.radians(self.lat), math.radians(other.lat)
        dlon = math.radians(other.lon - self.lon)
        y = math.sin(dlon) * math.cos(lat2)
        x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
        return (math.degrees(math.atan2(y, x)) + 360) % 360


# --- Projections -----------------------------------------------------------
# forward/inverse work on arrays: lat/lon in degrees -> x/y in meters.


class Projection:
    id: str
    name: str

    def forward(self, lat, lon):
        raise NotImplementedError

    def inverse(self, x, y):
        raise NotImplementedError

    def scale_factor(self, p: LatLng) -> float:
        """Projected meters per ground meter near p."""
        d = 1e-4
        x0, y0 = self.forward(p.lat, p.lon)
        x1, y1 = self.forward(p.lat + d, p.lon)
        return math.hypot(x1 - x0, y1 - y0) / (math.radians(d) * EARTH_RADIUS_M)

    def __eq__(self, other):
        return isinstance(other, Projection) and other.id == self.id

    def __hash__(self):
        return hash(self.id)


class WebMercator(Projection):
    id = "merc"
    name = "Mercator"
    _R = 6378137.0
    _MAX_LAT = 85.05112878

    def forward(self, lat, lon):
        lat = np.radians(np.clip(lat, -self._MAX_LAT, self._MAX_LAT))
        return self._R * np.radians(lon), self._R * np.log(np.tan(np.pi / 4 + lat / 2))

    def inverse(self, x, y):
        lat = np.degrees(2 * np.arctan(np.exp(np.asarray(y) / self._R)) - np.pi / 2)
        return lat, np.degrees(np.asarray(x) / self._R)


# WGS-84 Krüger series constants, as in the app.
_A = 6378137.0
_F = 1 / 298.257223563
_N = _F / (2 - _F)
_BIG_A = _A / (1 + _N) * (1 + _N**2 / 4 + _N**4 / 64)
_ALPHA = [_N / 2 - 2 * _N**2 / 3 + 5 * _N**3 / 16, 13 * _N**2 / 48 - 3 * _N**3 / 5, 61 * _N**3 / 240]
_BETA = [_N / 2 - 2 * _N**2 / 3 + 37 * _N**3 / 96, _N**2 / 48 + _N**3 / 15, 17 * _N**3 / 480]
_DELTA = [2 * _N - 2 * _N**2 / 3 - 2 * _N**3, 7 * _N**2 / 3 - 8 * _N**3 / 5, 56 * _N**3 / 15]
_E2N = 2 * math.sqrt(_N) / (1 + _N)


class TransverseMercator(Projection):
    def __init__(self, zone: int, north: bool = True):
        self.zone = zone
        self.north = north
        self.central_meridian = zone * 6.0 - 183
        self.scale = 0.9996
        self.false_easting = 500000.0
        self.false_northing = 0.0 if north else 10000000.0
        self.id = f"utm{zone}{'n' if north else 's'}"
        self.name = f"UTM zone {zone}{'N' if north else 'S'}"

    @staticmethod
    def utm_zone(lon: float) -> int:
        return min(max(int(math.floor((lon + 180) / 6)), 0), 59) + 1

    @classmethod
    def candidates(cls, lon: float, north: bool) -> list[TransverseMercator]:
        """The zone containing lon and both neighbours: states often keep one
        zone for charts that spill over a boundary."""
        z = cls.utm_zone(lon)
        return [cls(zone, north) for zone in (z, z - 1, z + 1) if 1 <= zone <= 60]

    def forward(self, lat, lon):
        phi = np.radians(lat)
        dl = np.radians(np.asarray(lon) - self.central_meridian)
        s = np.sin(phi)
        t = np.sinh(np.arctanh(s) - _E2N * np.arctanh(_E2N * s))
        xi = np.arctan2(t, np.cos(dl))
        eta = np.arctanh(np.sin(dl) / np.sqrt(1 + t * t))
        e, n = eta, xi
        for j in range(1, 4):
            e = e + _ALPHA[j - 1] * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
            n = n + _ALPHA[j - 1] * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
        return self.false_easting + self.scale * _BIG_A * e, self.false_northing + self.scale * _BIG_A * n

    def inverse(self, x, y):
        xi = (np.asarray(y) - self.false_northing) / (self.scale * _BIG_A)
        eta = (np.asarray(x) - self.false_easting) / (self.scale * _BIG_A)
        xi1, eta1 = xi, eta
        for j in range(1, 4):
            xi1 = xi1 - _BETA[j - 1] * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
            eta1 = eta1 - _BETA[j - 1] * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
        chi = np.arcsin(np.sin(xi1) / np.cosh(eta1))
        phi = chi
        for j in range(1, 4):
            phi = phi + _DELTA[j - 1] * np.sin(2 * j * chi)
        lam = np.arctan2(np.sinh(eta1), np.cos(xi1))
        return np.degrees(phi), self.central_meridian + np.degrees(lam)


WEB_MERCATOR = WebMercator()


def projection_from_id(pid: str | None) -> Projection:
    if pid is None or pid == "merc":
        return WEB_MERCATOR
    if pid.startswith("utm") and pid[-1] in "ns":
        return TransverseMercator(int(pid[3:-1]), pid[-1] == "n")
    return WEB_MERCATOR


# --- Chart transform -------------------------------------------------------


@dataclass(frozen=True)
class ControlPoint:
    """A pixel on the chart page and the ground position it shows."""

    x: float
    y: float
    pos: LatLng


class GeoreferenceError(Exception):
    pass


class Georeference:
    """pixel.x = a*X + b*Y + c; pixel.y = d*X + e*Y + f, with X, Y in the
    projection's meters. Similarity (scale/rotation/shift) or affine."""

    def __init__(self, coef, points, projection, is_affine):
        self.a, self.b, self.c, self.d, self.e, self.f = coef
        self.det = self.a * self.e - self.b * self.d
        self.points = list(points)
        self.projection = projection
        self.is_affine = is_affine

    @classmethod
    def fit(cls, points, projection: Projection = WEB_MERCATOR, conformal: bool = False) -> Georeference:
        if len(points) < 2:
            raise GeoreferenceError("At least 2 points are needed.")
        lat = np.array([p.pos.lat for p in points])
        lon = np.array([p.pos.lon for p in points])
        wx, wy = projection.forward(lat, lon)
        world = np.column_stack([wx, wy])
        pix = np.array([[p.x, p.y] for p in points], dtype=float)
        wc, pc = world.mean(axis=0), pix.mean(axis=0)
        w, px = world - wc, pix - pc
        result = None
        if len(points) > 2 and not conformal:
            result = cls._affine(w, px, wc, pc, points, projection)
        if result is None:
            result = cls._similarity(w, px, wc, pc, points, projection)
        if not math.isfinite(result.det) or abs(result.det) < 1e-18:
            raise GeoreferenceError("Points are too close together or in a line to define the chart.")
        return result

    @classmethod
    def _similarity(cls, w, px, wc, pc, points, projection):
        # x' = p*X + q*Y, y' = q*X - p*Y: rotation + scale with the image's
        # y-down flip against north-up world coordinates.
        X, Y, x, y = w[:, 0], w[:, 1], px[:, 0], px[:, 1]
        sxx = float(np.sum(X * X + Y * Y))
        if sxx == 0:
            raise GeoreferenceError("Points must be at different positions.")
        p = float(np.sum(X * x - Y * y)) / sxx
        q = float(np.sum(Y * x + X * y)) / sxx
        a, b, d, e = p, q, q, -p
        c = pc[0] - a * wc[0] - b * wc[1]
        f = pc[1] - d * wc[0] - e * wc[1]
        return cls((a, b, c, d, e, f), points, projection, False)

    @classmethod
    def _affine(cls, w, px, wc, pc, points, projection):
        X, Y = w[:, 0], w[:, 1]
        sXX, sXY, sYY = float(np.sum(X * X)), float(np.sum(X * Y)), float(np.sum(Y * Y))
        det = sXX * sYY - sXY * sXY
        trace = sXX + sYY
        root = math.sqrt(max(0.0, trace * trace / 4 - det))
        minor, major = trace / 2 - root, trace / 2 + root
        # Nearly collinear ground points leave one direction unconstrained.
        if major <= 0 or minor / major < 1e-3:
            return None
        sXx, sYx = float(np.sum(X * px[:, 0])), float(np.sum(Y * px[:, 0]))
        sXy, sYy = float(np.sum(X * px[:, 1])), float(np.sum(Y * px[:, 1]))
        a = (sXx * sYY - sYx * sXY) / det
        b = (sYx * sXX - sXx * sXY) / det
        d = (sXy * sYY - sYy * sXY) / det
        e = (sYy * sXX - sXy * sXY) / det
        c = pc[0] - a * wc[0] - b * wc[1]
        f = pc[1] - d * wc[0] - e * wc[1]
        return cls((a, b, c, d, e, f), points, projection, True)

    def world_to_pixel(self, wx, wy):
        return self.a * wx + self.b * wy + self.c, self.d * wx + self.e * wy + self.f

    def to_pixel(self, p: LatLng) -> tuple[float, float]:
        wx, wy = self.projection.forward(p.lat, p.lon)
        x, y = self.world_to_pixel(wx, wy)
        return float(x), float(y)

    def to_latlng(self, x: float, y: float) -> LatLng:
        x, y = x - self.c, y - self.f
        mx = (self.e * x - self.b * y) / self.det
        my = (-self.d * x + self.a * y) / self.det
        lat, lon = self.projection.inverse(mx, my)
        return LatLng(float(lat), float(lon))

    @property
    def meters_per_pixel(self) -> float:
        cx = sum(p.x for p in self.points) / len(self.points)
        cy = sum(p.y for p in self.points) / len(self.points)
        c = self.to_latlng(cx, cy)
        px, py = self.to_pixel(c)
        return self.to_latlng(px + 1, py).distance_to(c)

    def residuals_m(self) -> list[float]:
        return [self.to_latlng(p.x, p.y).distance_to(p.pos) for p in self.points]

    @property
    def rms_error_m(self) -> float | None:
        if len(self.points) < 3:
            return None
        r = self.residuals_m()
        return math.sqrt(sum(v * v for v in r) / len(r))

    def rms_pixels(self) -> float:
        s = 0.0
        for p in self.points:
            x, y = self.to_pixel(p.pos)
            s += (x - p.x) ** 2 + (y - p.y) ** 2
        return math.sqrt(s / len(self.points))
