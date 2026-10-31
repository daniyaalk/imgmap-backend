// Live aircraft positions for the replay page, served at /live/ on the same
// origin as the site, so the page needs no CORS and no API key.
//
// The page sees one shape whatever the source; each provider (./adsblol.js,
// later FR24) turns its own API into it. Choose one with the PROVIDER var.
//
//   GET /live/area?lat=28.56&lon=77.10&nm=40    aircraft within nm of a point
//   GET /live/search?q=IGO402                   by callsign or registration
//   GET /live/aircraft/<id>                     one aircraft, to follow it
//
// Each answers {source: {name, url}, now, pollS, aircraft: [Aircraft]}:
//   Aircraft = {id, callsign, reg, type, t, lat, lon, altFt, onGround,
//               gsKt, trackDeg, vsFpm}
// id is the provider's own (opaque to the page); t is when the position was
// received (ms); pollS is how often the page should ask again while
// following, so a provider with metered calls can slow every page down.
//
// Responses are cached briefly at the edge: everyone following a flight
// shares one upstream call per cache period.

import adsblol from "./adsblol.js";

const PROVIDERS = { adsblol };

/** adsb.lol's /v2/point accepts up to 250 NM. */
export const MAX_NM = 250;

export default {
  async fetch(request, env = {}, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET") return reply({ error: "GET only" }, 405);
    const provider = PROVIDERS[env.PROVIDER ?? "adsblol"];
    if (!provider) return reply({ error: `unknown provider ${env.PROVIDER}` }, 500);

    let route;
    try {
      route = parse(url);
    } catch (e) {
      return reply({ error: e.message }, 400);
    }
    if (!route) return reply({ error: "not found" }, 404);

    // One cache entry per normalised question, whatever the page asked.
    const key = new Request(new URL(`/live/${route.kind}/${route.key}`, url.origin));
    const cache = globalThis.caches?.default;
    const hit = await cache?.match(key);
    if (hit) return hit;

    let aircraft;
    try {
      aircraft = await provider[route.kind](route.args, env);
    } catch (e) {
      // A provider marks the page's mistakes 400; anything else is upstream's.
      return reply({ error: `${provider.source.name}: ${e.message}` }, e.status ?? 502);
    }
    const ttl = provider.cacheS[route.kind];
    const res = reply({ source: provider.source, now: Date.now(), pollS: provider.pollS, aircraft }, 200, ttl);
    if (cache) {
      const put = cache.put(key, res.clone());
      if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
    }
    return res;
  },
};

/** The route and its arguments, rounded so nearby questions share a cache entry. */
export function parse(url) {
  const path = url.pathname.replace(/^\/live\/?/, "/");
  const q = url.searchParams;
  if (path === "/area") {
    const lat = Number(q.get("lat")), lon = Number(q.get("lon")), nm = Number(q.get("nm") ?? 40);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && nm > 0)) throw new Error("lat, lon and nm are needed");
    // 0.1° and 5 NM steps: a few km off at most, against a radius of tens of NM.
    const args = { lat: round(lat, 0.1), lon: round(lon, 0.1), nm: Math.min(MAX_NM, Math.ceil(nm / 5) * 5) };
    return { kind: "area", args, key: `${args.lat}/${args.lon}/${args.nm}` };
  }
  if (path === "/search") {
    const text = (q.get("q") ?? "").trim().toUpperCase().replace(/\s+/g, "");
    if (!/^[A-Z0-9-]{2,10}$/.test(text)) throw new Error("search for a callsign or registration, e.g. IGO402 or VT-IPU");
    return { kind: "search", args: { q: text }, key: text };
  }
  const m = /^\/aircraft\/([A-Za-z0-9~_-]{1,40})$/.exec(path);
  if (m) return { kind: "aircraft", args: { id: m[1].toLowerCase() }, key: m[1].toLowerCase() };
  return null;
}

function round(v, step) {
  return Number((Math.round(v / step) * step).toFixed(4));
}

function reply(body, status = 200, cacheS = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheS ? `public, max-age=${cacheS}` : "no-store",
    },
  });
}
