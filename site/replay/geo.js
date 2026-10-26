// Positions on a georeferenced chart: the app's projections and
// control-point fit (lib/src/geo/ in ImgMap), ported as they are.

const EARTH_RADIUS_M = 6371008.8;

/** Great-circle distance in meters. */
export function distanceM(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial true course from a to b, degrees 0–360. */
export function bearingDeg(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

// --- Projections, in meters (x east, y north) ------------------------------

const webMercator = {
  id: "merc",
  forward({ lat, lon }) {
    const R = 6378137, max = 85.05112878;
    const phi = Math.max(-max, Math.min(max, lat)) * Math.PI / 180;
    return [R * lon * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + phi / 2))];
  },
  inverse([x, y]) {
    const R = 6378137;
    return { lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI, lon: x / R * 180 / Math.PI };
  },
};

/** Transverse Mercator on WGS-84 (Krüger series), as used by UTM. */
function transverseMercator(centralMeridian, falseNorthing, id) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, falseEasting = 500000;
  const n = f / (2 - f);
  const A = a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64);
  const alpha = [n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16, 13 * n * n / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240];
  const beta = [n / 2 - 2 * n * n / 3 + 37 * n ** 3 / 96, n * n / 48 + n ** 3 / 15, 17 * n ** 3 / 480];
  const delta = [2 * n - 2 * n * n / 3 - 2 * n ** 3, 7 * n * n / 3 - 8 * n ** 3 / 5, 56 * n ** 3 / 15];
  const e2n = 2 * Math.sqrt(n) / (1 + n);
  return {
    id,
    forward({ lat, lon }) {
      const phi = lat * Math.PI / 180, dLambda = (lon - centralMeridian) * Math.PI / 180;
      const s = Math.sin(phi);
      const t = Math.sinh(Math.atanh(s) - e2n * Math.atanh(e2n * s));
      const xi = Math.atan2(t, Math.cos(dLambda));
      const eta = Math.atanh(Math.sin(dLambda) / Math.sqrt(1 + t * t));
      let e = eta, nn = xi;
      for (let j = 1; j <= 3; j++) {
        e += alpha[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
        nn += alpha[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
      }
      return [falseEasting + k0 * A * e, falseNorthing + k0 * A * nn];
    },
    inverse([x, y]) {
      const xi = (y - falseNorthing) / (k0 * A), eta = (x - falseEasting) / (k0 * A);
      let xi1 = xi, eta1 = eta;
      for (let j = 1; j <= 3; j++) {
        xi1 -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
        eta1 -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
      }
      const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
      let phi = chi;
      for (let j = 1; j <= 3; j++) phi += delta[j - 1] * Math.sin(2 * j * chi);
      return { lat: phi * 180 / Math.PI, lon: centralMeridian + Math.atan2(Math.sinh(eta1), Math.cos(xi1)) * 180 / Math.PI };
    },
  };
}

/** The projection for a backend id (`merc`, `utm43n`), or null if unknown. */
export function projection(id) {
  if (id === "merc") return webMercator;
  const m = /^utm([1-9]|[1-5]\d|60)([ns])$/.exec(id ?? "");
  if (!m) return null;
  return transverseMercator(Number(m[1]) * 6 - 183, m[2] === "n" ? 0 : 10000000, id);
}

// --- Fitting control points --------------------------------------------------

/**
 * Maps between ground positions and pixels of a chart page that is
 * `width` × `height` pixels as displayed.
 *
 * `georef` is the backend's: points as page fractions (u, v), fitted in
 * `projection`, conformally (scale, rotation, shift) when `conformal` or
 * with two points, else as a least-squares affine.
 */
export class Georeference {
  constructor(georef, width, height) {
    const proj = projection(georef.projection);
    if (!proj) throw new Error(`Unknown projection ${georef.projection}`);
    const pts = georef.points ?? [];
    if (pts.length < 2) throw new Error("At least two points are needed.");
    this.projection = proj;
    const world = pts.map((p) => proj.forward(p));
    const pixels = pts.map((p) => [p.u * width, p.v * height]);
    // Centred, so mercator's ~1e7 m squared doesn't swamp small differences.
    const wc = mean(world), pc = mean(pixels);
    const w = world.map(([x, y]) => [x - wc[0], y - wc[1]]);
    const px = pixels.map(([x, y]) => [x - pc[0], y - pc[1]]);
    const m = (pts.length === 2 || georef.conformal ? null : fitAffine(w, px)) ?? fitSimilarity(w, px);
    const [a, b, d, e] = m;
    this.m = [a, b, pc[0] - a * wc[0] - b * wc[1], d, e, pc[1] - d * wc[0] - e * wc[1]];
    this.det = a * e - b * d;
    if (!Number.isFinite(this.det) || Math.abs(this.det) < 1e-18) throw new Error("Points don't define the chart.");
  }

  /** Pixel [x, y] for {lat, lon}. */
  toPixel(p) {
    const [X, Y] = this.projection.forward(p);
    const [a, b, c, d, e, f] = this.m;
    return [a * X + b * Y + c, d * X + e * Y + f];
  }

  /** {lat, lon} for pixel [x, y]. */
  toLatLng([px, py]) {
    const [a, b, c, d, e, f] = this.m;
    const x = px - c, y = py - f;
    return this.projection.inverse([(e * x - b * y) / this.det, (-d * x + a * y) / this.det]);
  }

  /** Screen angle (radians clockwise from page up) of true north at p. */
  northAngle(p) {
    const here = this.toPixel(p);
    const north = this.toPixel({ lat: Math.min(p.lat + 0.01, 85), lon: p.lon });
    return Math.atan2(north[0] - here[0], -(north[1] - here[1]));
  }
}

function fitSimilarity(w, px) {
  // pixel = s·R·world + t, as x' = pX + qY, y' = qX − pY: the image's y is
  // down where the projection's is north.
  let sxx = 0, n1 = 0, n2 = 0;
  for (let i = 0; i < w.length; i++) {
    const [X, Y] = w[i], [x, y] = px[i];
    sxx += X * X + Y * Y;
    n1 += X * x - Y * y;
    n2 += Y * x + X * y;
  }
  if (sxx === 0) throw new Error("Points must be at different positions.");
  const p = n1 / sxx, q = n2 / sxx;
  return [p, q, q, -p];
}

function fitAffine(w, px) {
  let sXX = 0, sXY = 0, sYY = 0, sXx = 0, sYx = 0, sXy = 0, sYy = 0;
  for (let i = 0; i < w.length; i++) {
    const [X, Y] = w[i];
    sXX += X * X; sXY += X * Y; sYY += Y * Y;
    sXx += X * px[i][0]; sYx += Y * px[i][0];
    sXy += X * px[i][1]; sYy += Y * px[i][1];
  }
  const det = sXX * sYY - sXY * sXY;
  // Nearly collinear points leave the cross direction unconstrained.
  const trace = sXX + sYY;
  const root = Math.sqrt(Math.max(0, trace * trace / 4 - det));
  const minor = trace / 2 - root, major = trace / 2 + root;
  if (major <= 0 || minor / major < 1e-3) return null;
  return [
    (sXx * sYY - sYx * sXY) / det,
    (sYx * sXX - sXx * sXY) / det,
    (sXy * sYY - sYy * sXY) / det,
    (sYy * sXX - sXy * sXY) / det,
  ];
}

function mean(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

/** Whether {lat, lon} lies in a polygon of [lat, lon] (even-odd). */
export function inPolygon(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ai, oi] = ring[i], [aj, oj] = ring[j];
    if ((ai > p.lat) !== (aj > p.lat) && p.lon < (oj - oi) * (p.lat - ai) / (aj - ai) + oi) inside = !inside;
  }
  return inside;
}
