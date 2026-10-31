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
