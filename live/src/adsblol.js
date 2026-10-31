// adsb.lol (https://api.adsb.lol/docs): free, no key, community ADS-B and
// MLAT receivers. Data under the ODbL, so the page credits it.

const API = "https://api.adsb.lol";
const USER_AGENT = "AIPChart live (https://charts.daniyaalkhan.com/replay/)";

export default {
  source: { name: "adsb.lol", url: "https://adsb.lol/" },
  pollS: 10,
  cacheS: { area: 10, search: 10, aircraft: 5 },

  async area({ lat, lon, nm }) {
    return normalise(await get(`/v2/point/${lat}/${lon}/${nm}`));
  },

  /** A callsign (IGO402) or a registration (VT-IPU): both are asked. */
  async search({ q }) {
    const asks = [get(`/v2/callsign/${encodeURIComponent(q)}`)];
    if (q.includes("-") || /^[A-Z]{2}[A-Z0-9]{3}$/.test(q)) asks.push(get(`/v2/reg/${encodeURIComponent(q)}`));
    const found = new Map();
    for (const body of await Promise.all(asks)) for (const a of normalise(body)) found.set(a.id, a);
    return [...found.values()];
  },

  async aircraft({ id }) {
    if (!/^~?[0-9a-f]{6}$/.test(id)) throw Object.assign(new Error("not an ICAO 24-bit address"), { status: 400 });
    return normalise(await get(`/v2/hex/${id}`));
  },
};

async function get(path) {
  const r = await fetch(API + path, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

/** readsb's aircraft fields → the page's. Aircraft without a position are left out. */
export function normalise(body) {
  const now = body.now ?? Date.now();
  return (body.ac ?? [])
    .filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon))
    .map((a) => {
      const onGround = a.alt_baro === "ground";
      const alt = onGround ? null : num(a.alt_baro) ?? num(a.alt_geom);
      return {
        id: a.hex,
        callsign: a.flight?.trim() || null,
        reg: a.r ?? null,
        type: a.t ?? null,
        t: Math.round(now - (num(a.seen_pos) ?? 0) * 1000),
        lat: a.lat,
        lon: a.lon,
        altFt: alt,
        onGround,
        gsKt: num(a.gs),
        trackDeg: num(a.track) ?? num(a.true_heading),
        vsFpm: onGround ? 0 : num(a.baro_rate) ?? num(a.geom_rate),
      };
    });
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
