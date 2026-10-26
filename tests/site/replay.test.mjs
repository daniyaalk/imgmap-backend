// The replay page's own logic. Run with: node --test tests/site/*.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Georeference, distanceM, inPolygon, projection } from "../../site/replay/geo.js";
import { UNTIMED_SPEED_KT, indexAt, parseKml, stateAt } from "../../site/replay/kml.js";

const charts = JSON.parse(readFileSync(new URL("../fixtures/charts.json", import.meta.url)));

test("projections round-trip", () => {
  for (const id of ["merc", "utm43n", "utm44n"]) {
    const p = projection(id);
    const back = p.inverse(p.forward({ lat: 28.5665, lon: 77.1031 }));
    assert.ok(distanceM(back, { lat: 28.5665, lon: 77.1031 }) < 0.01, id);
  }
  // UTM 43N: the same as the backend (imgmap_backend/geo.py).
  const [e, n] = projection("utm43n").forward({ lat: 28.5, lon: 77 });
  assert.ok(Math.abs(e - 695751.71) < 0.01 && Math.abs(n - 3154222.60) < 0.01, `${e} ${n}`);
  assert.equal(projection("lcc"), null);
});

test("matches the footprints the backend published", () => {
  // The backend fits the same points; the page corners must land where its
  // footprint says, whichever fit (affine or conformal) the chart uses.
  for (const c of charts) {
    const { width, height } = c.page;
    const g = new Georeference(c.georef, width, height);
    const corners = [[0, 0], [width, 0], [width, height], [0, height]];
    corners.forEach((px, i) => {
      const [lat, lon] = c.georef.footprint[i];
      const err = distanceM(g.toLatLng(px), { lat, lon });
      assert.ok(err < 5, `${c.title} corner ${i}: ${err.toFixed(1)} m`);
    });
    // And back again.
    const p = c.georef.points[0];
    const [x, y] = g.toPixel(p);
    assert.ok(Math.hypot(x - p.u * width, y - p.v * height) < 3, c.title);
  }
});

test("north is up on a north-up chart", () => {
  const c = charts[0];
  const g = new Georeference(c.georef, c.page.width, c.page.height);
  assert.ok(Math.abs(g.northAngle({ lat: 28.5, lon: 77.1 })) < 0.05);
  assert.ok(inPolygon({ lat: 28.5665, lon: 77.1031 }, c.georef.footprint));
  assert.ok(!inPolygon({ lat: 19.09, lon: 72.87 }, c.georef.footprint));
});

test("reads a gx:Track", () => {
  const f = parseKml(`<?xml version="1.0"?>
    <kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
    <Document><name>AIC101 &amp; co</name><Placemark><gx:Track>
      <when>2026-10-20T10:00:10Z</when><when>2026-10-20T10:00:00Z</when><when>2026-10-20T10:00:20Z</when>
      <gx:coord>77.01 28.51 900</gx:coord><gx:coord>77.00 28.50 1000</gx:coord><gx:coord>77.02 28.52 800</gx:coord>
    </gx:Track></Placemark></Document></kml>`);
  assert.equal(f.name, "AIC101 & co");
  assert.equal(f.timed, true);
  // Sorted by time, paired with its own coordinate.
  assert.deepEqual(f.points.map((p) => p.altM), [1000, 900, 800]);
  assert.equal(f.points[0].t, Date.parse("2026-10-20T10:00:00Z"));
  assert.equal(f.points[0].lon, 77.0);
});

test("reads Flightradar24-style timed points", () => {
  const point = (t, lon, lat, alt) => `<Placemark><name>${t}</name><description><![CDATA[<b>Speed:</b> 250 kt]]></description>
    <TimeStamp><when>${t}</when></TimeStamp><Point><coordinates>${lon},${lat},${alt}</coordinates></Point></Placemark>`;
  const f = parseKml(`<kml><Document><name><![CDATA[AI101/AIC101]]></name><Folder><name>Route</name>
    <Placemark><LineString><coordinates>1,1,0 2,2,0 3,3,0 4,4,0</coordinates></LineString></Placemark></Folder>
    <Folder><name>Trail</name>${point("2026-10-20T10:00:00Z", 77, 28.5, 3048)}${point("2026-10-20T10:01:00Z", 77.05, 28.5, 2743)}</Folder>
    </Document></kml>`);
  assert.equal(f.name, "AI101/AIC101");
  assert.equal(f.timed, true, "timed points win over the untimed route line");
  assert.equal(f.points.length, 2);

  // 0.05° of longitude at 28.5°N (4.89 km) in 60 s: 158 kt; 1000 ft down in a minute.
  const s = stateAt(f.points, Date.parse("2026-10-20T10:00:30Z"));
  assert.ok(Math.abs(s.groundSpeedKt - 158.3) < 0.5, `${s.groundSpeedKt}`);
  assert.ok(Math.abs(s.trackDeg - 90) < 1);
  assert.ok(Math.abs(s.verticalSpeedFpm + 1000) < 10, `${s.verticalSpeedFpm}`);
  assert.ok(Math.abs(s.lon - 77.025) < 1e-9);
});

test("replays a line without times at an assumed speed", () => {
  const f = parseKml(`<kml><Placemark><LineString><coordinates>
    77.0,28.5 77.1,28.5
    </coordinates></LineString></Placemark></kml>`);
  assert.equal(f.timed, false);
  assert.equal(f.points[0].altM, null);
  const seconds = f.points[1].t / 1000;
  assert.ok(Math.abs(distanceM(f.points[0], f.points[1]) / seconds * 3600 / 1852 - UNTIMED_SPEED_KT) < 1e-6);
  assert.throws(() => parseKml("<kml><Document/></kml>"), /No flight path/);
});

test("finds the sample before a time", () => {
  const pts = [{ t: 0 }, { t: 10 }, { t: 20 }];
  assert.deepEqual([-5, 0, 5, 10, 19, 25].map((t) => indexAt(pts, t)), [0, 0, 0, 1, 1, 2]);
});
