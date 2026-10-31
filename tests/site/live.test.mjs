// The replay page's live-flight helpers. Run with: node --test tests/site/*.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { distanceM } from "../../site/replay/geo.js";
import { MAX_AHEAD_MS, addFix, altitudeText, areaAround, label, liveStateAt, onChart } from "../../site/replay/live.js";

const report = (over = {}) => ({
  id: "8015fc", callsign: "IGO402", reg: "VT-IPU", type: "A20N", t: 1_000_000,
  lat: 28.5, lon: 77.0, altFt: 10000, onGround: false, gsKt: 360, trackDeg: 90, vsFpm: -1200, ...over,
});

test("keeps only newer reports", () => {
  const pts = [];
  assert.equal(addFix(pts, report()), true);
  assert.equal(addFix(pts, report()), false, "the same report twice");
  assert.equal(addFix(pts, report({ t: 999_000 })), false, "an older one");
  assert.equal(addFix(pts, report({ t: 1_010_000 })), true);
  assert.equal(pts.length, 2);
  assert.ok(Math.abs(pts[0].altM - 3048) < 1e-9);
  assert.equal(addFix(pts, report({ t: 1_020_000, onGround: true, altFt: null })), true);
  assert.equal(pts.at(-1).altM, 0, "on the ground is zero, not unknown");
});

test("carries the aircraft on from its last report", () => {
  const pts = [];
  addFix(pts, report());
  // 360 kt for 10 s: 1 NM east; 1200 ft/min down: 200 ft lower.
  const s = liveStateAt(pts, 1_010_000);
  assert.ok(Math.abs(distanceM(pts[0], s) - 1852) < 1, `${distanceM(pts[0], s)}`);
  assert.ok(Math.abs(s.lat - 28.5) < 1e-4 && s.lon > 77);
  assert.ok(Math.abs(s.altM / 0.3048 - 9800) < 0.01);
  assert.equal(s.ageMs, 10000);
  assert.equal(s.groundSpeedKt, 360);

  // Not beyond a minute, however long it's been; climbs for less.
  const far = liveStateAt(pts, 1_000_000 + 10 * MAX_AHEAD_MS);
  assert.ok(Math.abs(distanceM(pts[0], far) - 6 * 1852) < 1);
  assert.ok(Math.abs(far.altM / 0.3048 - 9600) < 0.01);

  // On the ground, or without speed: where it was reported.
  const parked = [];
  addFix(parked, report({ onGround: true, gsKt: 12 }));
  assert.ok(distanceM(parked[0], liveStateAt(parked, 1_030_000)) < 1e-6);
});

test("asks for the aircraft around a chart and keeps those on it", () => {
  const fp = [[28.7, 76.9], [28.7, 77.3], [28.4, 77.3], [28.4, 76.9]];
  const { lat, lon, nm } = areaAround(fp);
  assert.ok(Math.abs(lat - 28.55) < 1e-9 && Math.abs(lon - 77.1) < 1e-9);
  assert.ok(nm >= 13 && nm <= 14, `${nm}`);
  const near = report({ id: "a", lat: 28.56, lon: 77.11 });
  const edge = report({ id: "b", lat: 28.68, lon: 76.92 });
  const off = report({ id: "c", lat: 28.9, lon: 77.1 });
  assert.deepEqual(onChart([edge, off, near], fp).map((a) => a.id), ["a", "b"]);
});

test("names and altitudes", () => {
  assert.equal(label(report()), "IGO402");
  assert.equal(label(report({ callsign: null })), "VT-IPU");
  assert.equal(label(report({ callsign: null, reg: null })), "8015FC");
  assert.equal(altitudeText(report({ altFt: 33025 })), "FL330");
  assert.equal(altitudeText(report({ altFt: 9500 })), "9,500 ft");
  assert.equal(altitudeText(report({ onGround: true })), "Ground");
  assert.equal(altitudeText(report({ altFt: null })), "—");
});
