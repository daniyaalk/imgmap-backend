// Live flights from this site's /live/ API (live/ in the repository): the
// shape is the same whichever source the API uses, so nothing here knows
// about adsb.lol or FR24.

import { distanceM, inPolygon, offsetM } from "./geo.js";

/** Furthest ahead of the last report the aircraft is moved on. */
export const MAX_AHEAD_MS = 60000;
/** Climbs and descents level off; altitude is carried on for less. */
export const MAX_CLIMB_AHEAD_MS = 20000;
/** After this long without a report, following stops. */
export const LOST_AFTER_MS = 10 * 60000;

/** An API aircraft as a track point (the same fields KML points have, and more). */
export function toPoint(a) {
  return {
    t: a.t,
    lat: a.lat,
    lon: a.lon,
    altM: a.onGround ? 0 : a.altFt == null ? null : a.altFt * 0.3048,
    gsKt: a.gsKt,
    trackDeg: a.trackDeg,
    vsFpm: a.vsFpm,
    onGround: !!a.onGround,
  };
}

/** Appends a report if it's newer than the last; true when it was. */
export function addFix(points, a) {
  if (points.length && a.t <= points.at(-1).t) return false;
  points.push(toPoint(a));
  return true;
}

/**
 * The aircraft at time t (ms), at or after the last report: carried on
 * from it at its reported speed, track and vertical speed. Same fields as
 * kml.js's stateAt, plus ageMs, how old the report is.
 */
export function liveStateAt(points, t) {
  const p = points.at(-1);
  const age = Math.max(0, t - p.t);
  const moving = !p.onGround && p.gsKt != null && p.trackDeg != null;
  const ahead = Math.min(age, MAX_AHEAD_MS) / 1000;
  const pos = moving ? offsetM(p, p.trackDeg, p.gsKt * 1852 / 3600 * ahead) : { lat: p.lat, lon: p.lon };
  const climb = Math.min(age, MAX_CLIMB_AHEAD_MS) / 1000;
  const altM = p.altM == null ? null : Math.max(0, p.altM + (p.vsFpm ?? 0) * 0.3048 / 60 * climb);
  return {
    ...pos,
    altM,
    index: points.length - 1,
    groundSpeedKt: p.gsKt,
    trackDeg: p.trackDeg,
    verticalSpeedFpm: p.vsFpm,
    ageMs: age,
  };
}

/** The circle (centre, NM) around a chart footprint [[lat, lon], ...], for /live/area. */
export function areaAround(footprint) {
  const pts = footprint.map(([lat, lon]) => ({ lat, lon }));
  const centre = {
    lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
    lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length,
  };
  const nm = Math.max(...pts.map((p) => distanceM(centre, p))) / 1852;
  return { ...centre, nm: Math.max(5, Math.ceil(nm)) };
}

/** The aircraft inside a footprint, nearest its centre first. */
export function onChart(aircraft, footprint) {
  const { lat, lon } = areaAround(footprint);
  return aircraft
    .filter((a) => inPolygon(a, footprint))
    .sort((a, b) => distanceM({ lat, lon }, a) - distanceM({ lat, lon }, b));
}

/** "IGO402", else the registration, else the provider's id. */
export function label(a) {
  return a.callsign || a.reg || a.id.toUpperCase();
}

/** A flight level from 10,000 ft up, feet below. */
export function altitudeText(a) {
  if (a.onGround) return "Ground";
  if (a.altFt == null) return "—";
  return a.altFt >= 10000 ? `FL${String(Math.round(a.altFt / 100)).padStart(3, "0")}` : `${(Math.round(a.altFt / 10) * 10).toLocaleString()} ft`;
}

/**
 * An altitude typed as feet ("5000", "5,000 ft") or a flight level
 * ("FL100"), in feet: null when empty, NaN when it isn't one.
 */
export function parseAltitude(text) {
  const t = String(text ?? "").trim().toUpperCase().replace(/[,\s]/g, "").replace(/FT$/, "");
  if (!t) return null;
  const m = /^(FL)?(\d{1,5})$/.exec(t);
  if (!m) return NaN;
  return m[1] ? Number(m[2]) * 100 : Number(m[2]);
}

/**
 * The traffic to draw: without the aircraft being followed; without those
 * on the ground, if asked; and, with an altitude band (feet, either end
 * optional), only those reported inside it (the ground is 0 ft; no
 * altitude is outside any band).
 */
export function trafficShown(aircraft, { hideGround = false, minFt = null, maxFt = null, exclude = null } = {}) {
  const band = minFt != null || maxFt != null;
  return aircraft.filter((a) => {
    if (a.id === exclude || (hideGround && a.onGround)) return false;
    if (!band) return true;
    const alt = a.onGround ? 0 : a.altFt;
    return alt != null && (minFt == null || alt >= minFt) && (maxFt == null || alt <= maxFt);
  });
}
