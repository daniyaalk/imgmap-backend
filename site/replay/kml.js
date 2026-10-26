// Reads a flight from KML, as exported by flight trackers and EFBs:
//  - gx:Track: <when> times paired with <gx:coord> (FlightAware, ForeFlight,
//    Google Earth);
//  - placemarks with a <Point> and a <TimeStamp> (Flightradar24);
//  - a <LineString> with no times, replayed at an assumed speed.
// Plain text matching rather than DOMParser, so it also runs in node tests.

import { bearingDeg, distanceM } from "./geo.js";

/** Ground speed assumed for a track without times. */
export const UNTIMED_SPEED_KT = 140;

/**
 * Returns {name, points: [{t, lat, lon, altM}], timed}, points in time
 * order with t in milliseconds since the epoch (or since the start, when
 * untimed). altM is null when the file has no altitude.
 */
export function parseKml(text) {
  const kml = text.replace(/<!--[\s\S]*?-->/g, "");
  const name = firstText(kml, "name");

  let points = fromTracks(kml);
  if (points.length < 2) points = fromTimedPoints(kml);
  let timed = points.length >= 2;
  if (!timed) {
    points = fromLineStrings(kml);
    timed = false;
  }
  if (points.length < 2) throw new Error("No flight path found in this file: it needs a track, timed points or a line.");

  if (timed) {
    points.sort((a, b) => a.t - b.t);
    // Repeated timestamps would make a zero-length step.
    points = points.filter((p, i) => i === 0 || p.t > points[i - 1].t);
  } else {
    // Constant speed along the line.
    const mps = UNTIMED_SPEED_KT * 1852 / 3600;
    let t = 0;
    points.forEach((p, i) => {
      if (i > 0) t += distanceM(points[i - 1], p) / mps * 1000;
      p.t = t;
    });
  }
  return { name, points, timed };
}

function elements(kml, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "g");
  return [...kml.matchAll(re)].map((m) => m[1]);
}

function firstText(kml, tag) {
  const [body] = elements(kml, tag);
  if (body == null) return null;
  const text = body.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
  return decodeEntities(text) || null;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function time(s) {
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? t : null;
}

/** `lon lat alt` (gx:coord) or `lon,lat,alt` (coordinates). */
function coord(s, separator) {
  const [lon, lat, alt] = s.trim().split(separator).map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, altM: Number.isFinite(alt) ? alt : null };
}

function fromTracks(kml) {
  const points = [];
  for (const track of elements(kml, "Track")) {
    const whens = elements(track, "when").map(time);
    const coords = elements(track, "coord").map((c) => coord(c, /\s+/));
    for (let i = 0; i < Math.min(whens.length, coords.length); i++) {
      if (whens[i] != null && coords[i]) points.push({ t: whens[i], ...coords[i] });
    }
  }
  return points;
}

function fromTimedPoints(kml) {
  const points = [];
  for (const placemark of elements(kml, "Placemark")) {
    const [point] = elements(placemark, "Point");
    if (point == null) continue;
    const [stamp] = elements(placemark, "TimeStamp");
    const t = stamp == null ? null : (elements(stamp, "when").map(time)[0] ?? null);
    const [coords] = elements(point, "coordinates");
    const c = coords == null ? null : coord(coords, ",");
    if (t != null && c) points.push({ t, ...c });
  }
  return points;
}

function fromLineStrings(kml) {
  // The longest line: a file may also hold short ones (runways, legs).
  let best = [];
  for (const line of elements(kml, "LineString")) {
    const [coords] = elements(line, "coordinates");
    if (coords == null) continue;
    const pts = coords.trim().split(/\s+/).map((c) => coord(c, ",")).filter(Boolean);
    if (pts.length > best.length) best = pts;
  }
  return best.map((p) => ({ t: 0, ...p }));
}

/**
 * The aircraft at time t (ms): position interpolated between samples, with
 * ground speed (kt) and track (degrees) over the surrounding ~20 s, and
 * vertical speed (ft/min).
 */
export function stateAt(points, t) {
  const i = indexAt(points, t);
  const a = points[i], b = points[Math.min(i + 1, points.length - 1)];
  const f = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
  const pos = {
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    altM: a.altM == null || b.altM == null ? null : a.altM + (b.altM - a.altM) * f,
  };
  // A window around t, so jittery samples don't make the readouts jump.
  const from = points[indexAt(points, t - 10000)];
  let to = points[Math.min(indexAt(points, t + 10000) + 1, points.length - 1)];
  if (to === from) to = b;
  const dt = (to.t - from.t) / 1000;
  const d = distanceM(from, to);
  return {
    ...pos,
    index: i,
    groundSpeedKt: dt > 0 ? d / dt * 3600 / 1852 : null,
    trackDeg: d > 5 ? bearingDeg(from, to) : null,
    verticalSpeedFpm: dt > 0 && from.altM != null && to.altM != null ? (to.altM - from.altM) / 0.3048 / dt * 60 : null,
  };
}

/** The last sample at or before t (0 before the start). */
export function indexAt(points, t) {
  let lo = 0, hi = points.length - 1;
  if (t <= points[0].t) return 0;
  if (t >= points[hi].t) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid; else hi = mid;
  }
  return lo;
}
