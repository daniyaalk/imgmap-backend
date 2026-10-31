// The /live/ Worker, with adsb.lol answered from here. Run with:
// node --test tests/live/*.test.mjs

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { normalise } from "../../live/src/adsblol.js";
import worker, { parse } from "../../live/src/index.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** adsb.lol stand-in: records what was asked, answers with these aircraft. */
function upstream(ac, status = 200) {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ ac, now: 1_793_436_000_000, msg: "No error" }), { status });
  };
  return asked;
}

const ask = async (path, env = {}) => {
  const r = await worker.fetch(new Request(`https://charts.example${path}`), env);
  return { status: r.status, cache: r.headers.get("Cache-Control"), body: await r.json() };
};

const igo = {
  hex: "8015fc", flight: "IGO402  ", r: "VT-IPU", t: "A20N", alt_baro: 33025, alt_geom: 34550,
  gs: 406.9, track: 208.96, baro_rate: -64, lat: 28.35, lon: 76.83, seen_pos: 0.8,
};

test("readsb fields become the page's", () => {
  const [a, b] = normalise({
    now: 1_000_000,
    ac: [igo, { hex: "800abc", alt_baro: "ground", gs: 12, true_heading: 270, lat: 28.56, lon: 77.1 }, { hex: "nopos" }],
  });
  assert.deepEqual(a, {
    id: "8015fc", callsign: "IGO402", reg: "VT-IPU", type: "A20N", t: 999_200,
    lat: 28.35, lon: 76.83, altFt: 33025, onGround: false, gsKt: 406.9, trackDeg: 208.96, vsFpm: -64,
  });
  assert.equal(b.onGround, true);
  assert.equal(b.altFt, null);
  assert.equal(b.trackDeg, 270, "heading when there's no track");
  assert.equal(b.callsign, null);
});

test("nearby questions share one upstream call", () => {
  const a = parse(new URL("https://x/live/area?lat=28.5612&lon=77.1031&nm=37"));
  const b = parse(new URL("https://x/live/area?lat=28.58&lon=77.08&nm=40"));
  assert.equal(a.key, b.key);
  assert.deepEqual(a.args, { lat: 28.6, lon: 77.1, nm: 40 });
  assert.equal(parse(new URL("https://x/live/area?lat=10&lon=10&nm=900")).args.nm, 250);
  assert.equal(parse(new URL("https://x/live/search?q=%20igo%20402")).key, "IGO402");
  assert.throws(() => parse(new URL("https://x/live/search?q=<script>")));
  assert.equal(parse(new URL("https://x/live/other")), null);
});

test("answers an area, a search and one aircraft", async () => {
  let asked = upstream([igo]);
  const area = await ask("/live/area?lat=28.56&lon=77.10&nm=40");
  assert.equal(area.status, 200);
  assert.deepEqual(asked, ["https://api.adsb.lol/v2/point/28.6/77.1/40"]);
  assert.deepEqual(area.body.source, { name: "adsb.lol", url: "https://adsb.lol/" });
  assert.equal(area.body.pollS, 10);
  assert.equal(area.body.aircraft[0].callsign, "IGO402");
  assert.equal(area.cache, "public, max-age=10");

  asked = upstream([igo]);
  const reg = await ask("/live/search?q=vt-ipu");
  assert.deepEqual(asked.sort(), ["https://api.adsb.lol/v2/callsign/VT-IPU", "https://api.adsb.lol/v2/reg/VT-IPU"]);
  assert.equal(reg.body.aircraft.length, 1, "found by both, listed once");

  asked = upstream([igo]);
  await ask("/live/search?q=IGO402");
  assert.deepEqual(asked, ["https://api.adsb.lol/v2/callsign/IGO402"], "a callsign isn't a registration");

  asked = upstream([igo]);
  const one = await ask("/live/aircraft/8015FC");
  assert.deepEqual(asked, ["https://api.adsb.lol/v2/hex/8015fc"]);
  assert.equal(one.cache, "public, max-age=5");
});

test("errors say whose they are, and aren't cached", async () => {
  upstream([]);
  assert.equal((await ask("/live/aircraft/not-hex")).status, 400);
  assert.equal((await ask("/live/area?lat=north")).status, 400);
  assert.equal((await ask("/live/nothing")).status, 404);
  for (const bare of ["/live", "/live/"]) {
    const about = await ask(bare);
    assert.equal(about.status, 200, bare);
    assert.equal(about.body.endpoints.length, 3);
  }
  upstream([], 503);
  const down = await ask("/live/aircraft/8015fc");
  assert.equal(down.status, 502);
  assert.equal(down.cache, "no-store");
  assert.match(down.body.error, /^adsb\.lol: 503/);
  assert.equal((await ask("/live/area?lat=1&lon=1", { PROVIDER: "fr24" })).status, 500, "a provider that isn't there");
});
