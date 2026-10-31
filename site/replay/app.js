// Flight replay: a KML track, or a live flight from /live/, drawn on a
// georeferenced AIP chart from this site's own /v1/ data, with the aircraft
// moving along it.

import * as pdfjs from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
import { Georeference, inPolygon, projection } from "./geo.js";
import { parseKml, stateAt } from "./kml.js";
import { LOST_AFTER_MS, addFix, altitudeText, areaAround, label, liveStateAt, onChart, parseAltitude, toPoint, trafficShown } from "./live.js";

const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
const JSZIP = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

// A module worker can't start from another origin; a same-origin blob that
// imports it can.
pdfjs.GlobalWorkerOptions.workerPort = new Worker(
  URL.createObjectURL(new Blob([`import "${PDFJS_WORKER}";`], { type: "text/javascript" })),
  { type: "module" },
);

/** Where /v1/ and /pdf/ live: this site, or ?data= for development. */
const DATA = new URL(new URLSearchParams(location.search).get("data") ?? "/", location.href);
/** The live positions API (live/ in the repository), on this site. */
const LIVE = new URL("/live/", location.href);

/** The official source of each country's AIP, credited on the page. */
const SOURCES = {
  "in-aai": { name: "AIP India", publisher: "Airports Authority of India", url: "https://aim-india.aai.aero/" },
};

const CATEGORIES = {
  aerodrome: "Aerodrome", ground: "Ground movement", parking: "Parking and docking",
  departure: "Departure (SID)", arrival: "Arrival (STAR)", approach: "Approach",
  terrain: "Terrain and obstacles", tabular: "Tables", other: "Other",
};
const CATEGORY_ORDER = Object.keys(CATEGORIES);

/** Track samples tested against each chart's footprint. */
const COVERAGE_SAMPLES = 400;
/** While following, how often the chart list is brought up to date. */
const LIVE_RESEARCH_MS = 60000;

const $ = (id) => document.getElementById(id);
const stage = $("stage"), layer = $("layer"), marker = $("marker");

const S = {
  flight: null,
  fileName: null,
  country: null,
  editions: [],
  edition: null,
  aerodromes: null, // usable ICAOs of the edition; null while loading
  ad: new Map(), // "<edition>/<ICAO>" → promise of the aerodrome's JSON
  chart: null, // {icao, ...chart entry}
  page: null,
  W: 0, H: 0, // displayed page size, PDF points
  geo: null,
  px: null, // the track in page points
  flown: null,
  view: { s: 1, x: 0, y: 0 },
  renderedScale: 0,
  renderTask: null,
  t: 0,
  state: null,
  rotation: 0,
  playing: false,
  last: null,
  found: null, // charts the flight crosses, once searched
  searched: 0,
  runs: { find: 0, open: 0, live: 0 },
  live: null, // while following: {id, source, pollS, offset, timer, searchedAt, failures}
  // Every aircraft on the open chart, when shown.
  traffic: { aircraft: [], els: new Map(), offset: 0, pollS: 10, source: null, timer: null, run: 0, failures: 0, error: null, at: null, loop: false },
};

// --- Data ------------------------------------------------------------------

const json = new Map();
function fetchJson(path) {
  const url = new URL(path, DATA).href;
  if (!json.has(url)) {
    json.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
      return r.json();
    }).catch((e) => { json.delete(url); throw e; }));
  }
  return json.get(url);
}

function aerodrome(icao) {
  return fetchJson(`v1/${S.country.id}/${S.edition.id}/ad/${icao}.json`);
}

/** Charts the page can place a position on. */
function usable(c) {
  return c.georef && c.pdf && projection(c.georef.projection) && (c.georef.points?.length ?? 0) >= 2;
}

async function init() {
  wireUi();
  try {
    const { countries } = await fetchJson("v1/countries.json");
    const select = $("country");
    for (const c of countries) select.append(new Option(c.country, c.id));
    select.hidden = countries.length < 2;
    select.onchange = () => chooseCountry(countries.find((c) => c.id === select.value));
    const wanted = parseHash();
    await chooseCountry(countries.find((c) => c.id === wanted?.country) ?? countries[0], wanted?.edition);
    if (wanted) {
      const ad = await aerodrome(wanted.icao);
      const chart = ad.charts.find((c) => c.file === wanted.file && usable(c));
      if (chart) {
        openChart(wanted.icao, chart);
      }
    }
  } catch (e) {
    $("charts").replaceChildren(el("p", "status error", `Couldn't load the chart list: ${e.message}`));
  }
}

async function chooseCountry(country, editionId) {
  S.country = country;
  $("country").value = country.id;
  const src = SOURCES[country.id];
  const line = $("source-line");
  if (src) {
    line.replaceChildren("Charts: ", link(src.name, src.url), `, published by the ${src.publisher}. Always use the official source for current information.`);
  } else {
    line.textContent = `Charts: AIP ${country.country}, published by ${country.authority}.`;
  }
  const { editions } = await fetchJson(`v1/${country.id}/editions.json`);
  S.editions = [...editions].sort((a, b) => a.effective.localeCompare(b.effective));
  const select = $("edition");
  const today = new Date().toISOString().slice(0, 10);
  select.replaceChildren(...S.editions.map((e) =>
    new Option(`${e.name} · ${e.effective > today ? "from" : "since"} ${formatDate(e.effective)}`, e.id)));
  select.onchange = () => chooseEdition(S.editions.find((e) => e.id === select.value));
  await chooseEdition(S.editions.find((e) => e.id === editionId) ?? editionFor(flightDate()));
}

/** The edition in force on a day (ms), or the earliest listed. */
function editionFor(t) {
  const day = new Date(t).toISOString().slice(0, 10);
  let pick = S.editions[0];
  for (const e of S.editions) if (e.effective <= day) pick = e;
  return pick;
}

function flightDate() {
  return S.flight?.timed ? S.flight.points[0].t : Date.now();
}

async function chooseEdition(edition) {
  S.edition = edition;
  S.aerodromes = null; // loading; searches wait for chooseEdition to rerun them
  $("edition").value = edition.id;
  showCharts();
  let aerodromes;
  try {
    ({ aerodromes } = await fetchJson(`v1/${S.country.id}/${edition.id}/aerodromes.json`));
  } catch (e) {
    if (S.edition !== edition) return;
    S.aerodromes = [];
    $("charts").replaceChildren(el("p", "status error", `Couldn't load the aerodromes of ${edition.name} (${e.message}). Choose the edition again to retry.`));
    return;
  }
  if (S.edition !== edition) return;
  S.aerodromes = aerodromes.filter((a) => a.usable > 0).map((a) => a.icao);
  $("icaos").replaceChildren(...S.aerodromes.map((icao) => new Option(icao)));
  findCharts();
}

// --- Finding charts ----------------------------------------------------------

/** The aerodrome typed in the filter, if the edition has it. */
function aerodromeFilter() {
  const v = $("icao").value.trim().toUpperCase();
  return S.aerodromes?.includes(v) ? v : null;
}

/**
 * Every usable chart whose footprint the flight passes through. A quiet
 * search (a live flight's update) keeps the current list until it's done.
 */
async function findCharts({ quiet = false } = {}) {
  const run = ++S.runs.find;
  if (!quiet || !S.found) {
    S.found = null;
    S.searched = 0;
    showCharts();
  }
  if (!S.flight || !S.aerodromes) return; // chooseEdition searches once they're in
  const samples = sample(S.flight.points, COVERAGE_SAMPLES);
  const now = S.flight.live ? S.flight.points.at(-1) : null;
  const found = [];
  const queue = [...S.aerodromes];
  const worker = async () => {
    while (queue.length) {
      const icao = queue.shift();
      try {
        const ad = await aerodrome(icao);
        for (const c of ad.charts) {
          if (!usable(c) || !c.georef.footprint) continue;
          const n = samples.filter((p) => inPolygon(p, c.georef.footprint)).length;
          const here = !!now && inPolygon(now, c.georef.footprint);
          if (n || here) found.push({ icao, chart: c, cover: n / samples.length, here, area: area(c.georef.footprint) });
        }
      } catch { /* One aerodrome missing doesn't stop the search. */ }
      if (run !== S.runs.find) return;
      S.searched++;
      if (!quiet) showCharts();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (run !== S.runs.find) return;
  // Where a live aircraft is now, the most detailed first; then most of
  // the flight; among equals, the more detailed chart.
  S.found = found.sort((a, b) =>
    b.here - a.here || (a.here ? a.area - b.area : b.cover - a.cover || a.area - b.area));
  showCharts();
}

/**
 * The chart list: with a flight, the charts it crosses (only the typed
 * aerodrome's, when one is typed); without, the typed aerodrome's charts.
 */
async function showCharts() {
  const box = $("charts");
  const icao = aerodromeFilter();
  const status = (text, cls = "status") => el("p", cls, text);
  if (!S.aerodromes) {
    box.replaceChildren(status("Loading the chart list…"));
    return;
  }
  if (S.flight) {
    if (!S.found) {
      box.replaceChildren(status(`Looking for charts this flight crosses… ${S.searched} of ${S.aerodromes.length} aerodromes`));
      return;
    }
    const found = icao ? S.found.filter((f) => f.icao === icao) : S.found;
    const where = icao ? ` ${icao}` : "";
    const plural = found.length === 1 ? "" : "s";
    box.replaceChildren(
      !found.length
        ? status(`This flight ${S.flight.live ? "isn't on and hasn't crossed" : "doesn't cross"} any${where} chart placed on the map in ${S.edition.name}.`)
        : S.flight.live
          ? status(`${found.length}${where} chart${plural} where the aircraft is now (marked “now”) or has been`)
          : status(`${found.length}${where} chart${plural} this flight crosses, with the share of the flight on each`),
      ...found.slice(0, icao ? undefined : 40).map((f) => chartButton(f.icao, f.chart, S.flight.live ? null : f.cover, f.here)),
    );
    return;
  }
  if (!icao) {
    box.replaceChildren(status("Load a flight to find the charts it crosses, or type an aerodrome to see its charts."));
    return;
  }
  box.replaceChildren(status(`Loading ${icao}…`));
  try {
    const ad = await aerodrome(icao);
    if (aerodromeFilter() !== icao || S.flight) return;
    const charts = ad.charts.filter(usable).sort((a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.title.localeCompare(b.title));
    box.replaceChildren(
      status(`${charts.length} of ${ad.charts.length} ${icao} charts can show a position`),
      ...charts.map((c) => chartButton(icao, c, null)),
    );
  } catch (e) {
    box.replaceChildren(status(`Couldn't load ${icao}: ${e.message}`, "status error"));
  }
}

function chartButton(icao, chart, cover, here = false) {
  const b = el("button", "chart");
  b.dataset.key = `${icao}/${chart.file}`;
  b.classList.toggle("on", S.chart != null && b.dataset.key === `${S.chart.icao}/${S.chart.file}`);
  b.append(
    el("span", "icao", icao),
    el("span", "title", chart.title),
    here
      ? el("span", "cover here", "now")
      : el("span", "cover", cover == null ? "" : cover > 0 ? `${Math.max(1, Math.round(cover * 100))}%` : ""),
    el("span", "cat", CATEGORIES[chart.category] ?? "Chart"),
  );
  b.title = chart.title;
  b.onclick = () => openChart(icao, chart);
  return b;
}

function sample(points, n) {
  if (points.length <= n) return points;
  return Array.from({ length: n }, (_, i) => points[Math.round(i * (points.length - 1) / (n - 1))]);
}

function area(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][1] + ring[i][1]) * (ring[j][0] - ring[i][0]);
  return Math.abs(a / 2);
}

// --- The chart -----------------------------------------------------------------

async function openChart(icao, chart) {
  const run = ++S.runs.open;
  S.chart = { icao, ...chart };
  for (const b of document.querySelectorAll(".chart")) b.classList.toggle("on", b.dataset.key === `${icao}/${chart.file}`);
  history.replaceState(null, "", `#chart=${[S.country.id, S.edition.id, icao, encodeURIComponent(chart.file)].join("/")}`);
  const title = $("chart-title");
  title.hidden = false;
  title.textContent = `${icao} · ${chart.title} · loading…`;
  $("empty").hidden = true;
  try {
    const pdf = await pdfjs.getDocument({ url: new URL(chart.pdf.path, DATA).href }).promise;
    const page = await pdf.getPage(1);
    if (run !== S.runs.open) return;
    const vp = page.getViewport({ scale: 1 }); // with the page's own rotation
    S.renderTask?.cancel();
    S.page = page;
    S.W = vp.width;
    S.H = vp.height;
    S.geo = new Georeference(chart.georef, S.W, S.H);
    S.renderedScale = 0;
    layer.replaceChildren();
    layer.style.width = `${S.W}px`;
    layer.style.height = `${S.H}px`;
    layer.hidden = false;
    title.textContent = `${icao} · ${chart.title} · drawing…`;
    $("live-near").disabled = !chart.georef.footprint;
    $("live-near").title = "";
    $("traffic").disabled = !chart.georef.footprint;
    title.title = `${chart.title} (${S.edition.name}). Positioned from ${chart.georef.method}, about ${Math.round(chart.georef.accuracyM)} m.`;
    buildOverlay();
    fitView();
    setTraffic();
    if (S.flight) updateFrame(); else applyView();
  } catch (e) {
    if (run === S.runs.open) title.textContent = `${icao} · ${chart.title}: couldn't open (${e.message})`;
  }
}

function buildOverlay() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${S.W} ${S.H}`);
  svg.innerHTML = `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width="6" height="6" fill="#8881"/><line x1="0" y1="0" x2="0" y2="6" stroke="#8886" stroke-width="2"/></pattern></defs>`;
  // Parts drawn not to scale: a position there would be misleading.
  for (const [u1, v1, u2, v2] of S.chart.georef.notToScale ?? []) {
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("class", "nts");
    r.setAttribute("x", Math.min(u1, u2) * S.W);
    r.setAttribute("y", Math.min(v1, v2) * S.H);
    r.setAttribute("width", Math.abs(u2 - u1) * S.W);
    r.setAttribute("height", Math.abs(v2 - v1) * S.H);
    svg.append(r);
  }
  const trail = document.createElementNS(NS, "path");
  trail.setAttribute("class", "trail");
  const flown = document.createElementNS(NS, "path");
  flown.setAttribute("class", "flown");
  svg.append(trail, flown);
  layer.append(svg);
  S.flown = null;
  S.px = S.flight ? S.flight.points.map((p) => S.geo.toPixel(p)) : null;
  trail.setAttribute("d", S.px ? path(S.px) : "");
}

/** Points too far off the page (or unprojectable) break the line. */
function onSheet(p) {
  const lim = 20 * Math.max(S.W, S.H);
  return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) < lim && Math.abs(p[1]) < lim;
}

function path(px) {
  let d = "", pen = false;
  for (const p of px) {
    if (onSheet(p)) { d += `${pen ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`; pen = true; } else pen = false;
  }
  return d;
}

/** The line flown up to sample i, then to the aircraft; built incrementally. */
function flownPath(i, here) {
  let c = S.flown;
  if (!c || c.i > i) c = S.flown = { i: -1, d: "", pen: false };
  for (let k = c.i + 1; k <= i; k++) {
    const p = S.px[k];
    if (onSheet(p)) { c.d += `${c.pen ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`; c.pen = true; } else c.pen = false;
  }
  c.i = i;
  return onSheet(here) && c.pen ? `${c.d}L${here[0].toFixed(1)} ${here[1].toFixed(1)}` : c.d;
}

// --- View: pan, zoom, render -------------------------------------------------

function fitScale() {
  const r = stage.getBoundingClientRect();
  return Math.min(r.width / S.W, r.height / S.H) * 0.96;
}

function fitView() {
  const r = stage.getBoundingClientRect();
  const s = fitScale();
  S.view = { s, x: (r.width - S.W * s) / 2, y: (r.height - S.H * s) / 2 };
}

function applyView() {
  const v = S.view;
  layer.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
  placeMarker();
  placeTraffic();
  if (S.page && Math.abs(S.renderedScale - v.s) / v.s > 0.02) {
    clearTimeout(S.renderTimer);
    S.renderTimer = setTimeout(render, S.renderedScale ? 150 : 0);
  }
}

function zoomAt(factor, cx, cy) {
  if (!S.page) return;
  const v = S.view, fit = fitScale();
  const s = Math.min(fit * 40, Math.max(fit * 0.5, v.s * factor));
  if (cx == null) {
    const r = stage.getBoundingClientRect();
    [cx, cy] = $("follow").checked && S.state ? screenOf(S.geo.toPixel(S.state)) : [r.width / 2, r.height / 2];
  }
  v.x = cx - (cx - v.x) * s / v.s;
  v.y = cy - (cy - v.y) * s / v.s;
  v.s = s;
  if ($("follow").checked && S.flight) updateFrame(); else applyView();
}

function screenOf(p) {
  return [S.view.x + p[0] * S.view.s, S.view.y + p[1] * S.view.s];
}

/** Renders the page sharp for the current zoom, then swaps it in. */
async function render() {
  const page = S.page;
  if (!page) return;
  const scale = S.view.s;
  // Within what browsers will allocate for one canvas.
  const k = Math.min(scale * (devicePixelRatio || 1), 8192 / Math.max(S.W, S.H), Math.sqrt(40e6 / (S.W * S.H)));
  const vp = page.getViewport({ scale: k });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  S.renderTask?.cancel();
  const task = S.renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
  S.renderedScale = scale;
  try {
    await task.promise;
  } catch (e) {
    if (e?.name === "RenderingCancelledException") return;
    throw e;
  }
  if (page !== S.page) return;
  const old = layer.querySelector("canvas");
  if (old) old.replaceWith(canvas); else layer.prepend(canvas);
  $("chart-title").textContent = `${S.chart.icao} · ${S.chart.title}`;
}

// --- The flight ----------------------------------------------------------------

async function loadFile(file) {
  stopLive();
  const info = $("flight-info");
  info.hidden = false;
  info.replaceChildren(el("span", "muted", `Reading ${file.name}…`));
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text;
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) { // "PK": a KMZ (zip)
      const JSZip = await loadScript(JSZIP, "JSZip");
      const zip = await JSZip.loadAsync(bytes);
      const kml = Object.values(zip.files).find((f) => !f.dir && /\.kml$/i.test(f.name));
      if (!kml) throw new Error("There's no KML file inside this KMZ.");
      text = await kml.async("string");
    } else {
      text = new TextDecoder().decode(bytes);
    }
    setFlight(parseKml(text), file.name);
  } catch (e) {
    info.replaceChildren(el("span", "error", `Couldn't read ${file.name}: ${e.message}`));
  }
}

function setFlight(flight, fileName) {
  setPlaying(false);
  S.flight = flight;
  S.fileName = fileName;
  S.t = flight.points[0].t;
  S.rotation = 0;
  const pts = flight.points;
  const first = pts[0].t, last = pts.at(-1).t;
  const alts = pts.map((p) => p.altM).filter((a) => a != null);
  const info = $("flight-info");
  const lines = [el("strong", null, flight.name ?? fileName)];
  if (flight.live) {
    // Filled in by showLiveInfo.
  } else if (flight.timed) {
    const d = new Date(first);
    lines.push(el("div", "muted", `${d.toUTCString().slice(0, 16)} · ${clock(first)}–${clock(last)} UTC`));
  }
  if (!flight.live) lines.push(el("div", "muted", [
    `${duration(last - first)}`,
    `${pts.length.toLocaleString()} positions`,
    alts.length ? `up to ${Math.round(Math.max(...alts) / 0.3048).toLocaleString()} ft` : null,
  ].filter(Boolean).join(" · ")));
  if (!flight.timed) lines.push(el("div", "note", "This file has no times, so the flight is replayed at a steady 140 kt."));
  if (!alts.length && !flight.live) lines.push(el("div", "note", "This file has no altitudes."));
  info.replaceChildren(...lines);
  info.hidden = false;
  $("player").hidden = false;
  $("player").classList.toggle("live", !!flight.live);
  $("live-tag").hidden = !flight.live;
  $("profile-box").hidden = !alts.length && !flight.live;
  profile.cols = null;

  // The charts in force on the day of the flight, when this site has them.
  const edition = editionFor(flightDate());
  if (S.edition && edition !== S.edition) chooseEdition(edition); else findCharts();
  if (S.geo) {
    buildOverlay();
    updateFrame();
  }
}

function updateFrame() {
  const f = S.flight;
  if (!f) return;
  const st = S.state = f.live ? liveStateAt(f.points, S.t) : stateAt(f.points, S.t);
  if (st.trackDeg != null) S.rotation = st.trackDeg;
  const first = f.points[0].t, last = f.points.at(-1).t;
  if (!f.live) $("seek").value = last > first ? Math.round((S.t - first) / (last - first) * 1000) : 0;
  $("clock").textContent = f.timed ? `${clock(S.t)} Z` : `+${duration(S.t - first, true)}`;
  setReadout("r-alt", st.altM == null ? null : (Math.round(st.altM / 0.3048 / 10) * 10).toLocaleString(), "ft");
  setReadout("r-gs", st.groundSpeedKt == null ? null : Math.round(st.groundSpeedKt), "kt");
  setReadout("r-trk", st.trackDeg == null ? null : `${String(Math.round(st.trackDeg) % 360).padStart(3, "0")}°`, "");
  const vs = st.verticalSpeedFpm;
  setReadout("r-vs", vs == null ? null : `${vs > 25 ? "+" : ""}${(Math.round(vs / 50) * 50).toLocaleString()}`, "ft/min");

  drawProfile();
  if (S.geo) {
    const here = S.geo.toPixel(st);
    layer.querySelector(".flown")?.setAttribute("d", flownPath(st.index, here));
    if ($("follow").checked && onSheet(here)) {
      const r = stage.getBoundingClientRect();
      S.view.x = r.width / 2 - here[0] * S.view.s;
      S.view.y = r.height / 2 - here[1] * S.view.s;
    }
  }
  applyView();
}

function placeMarker() {
  const where = $("where");
  if (!S.geo || !S.state) { marker.hidden = true; where.hidden = true; return; }
  const p = S.geo.toPixel(S.state);
  if (!onSheet(p)) { marker.hidden = true; where.hidden = false; where.textContent = "Off this chart"; return; }
  const [x, y] = screenOf(p);
  const angle = S.rotation * Math.PI / 180 + S.geo.northAngle(S.state);
  marker.hidden = false;
  marker.style.transform = `translate(${x}px, ${y}px) rotate(${angle}rad)`;
  const u = p[0] / S.W, v = p[1] / S.H;
  const off = u < 0 || u > 1 || v < 0 || v > 1;
  const nts = notToScale(u, v);
  marker.classList.toggle("dim", off || nts);
  where.hidden = !(off || nts);
  where.textContent = off ? "Off this chart" : "In a part drawn not to scale: position approximate";
}

/** Whether a page position (0–1) is in a part of the chart drawn not to scale. */
function notToScale(u, v) {
  return (S.chart.georef.notToScale ?? []).some(([u1, v1, u2, v2]) =>
    u >= Math.min(u1, u2) && u <= Math.max(u1, u2) && v >= Math.min(v1, v2) && v <= Math.max(v1, v2));
}

function setPlaying(on) {
  const f = S.flight;
  if (f?.live) return; // a live flight runs on the clock
  if (on && f && S.t >= f.points.at(-1).t) S.t = f.points[0].t;
  S.playing = on && !!f;
  S.last = null;
  $("play").textContent = S.playing ? "❚❚" : "▶";
  $("play").setAttribute("aria-label", S.playing ? "Pause" : "Play");
  if (S.playing) requestAnimationFrame(tick);
}

function tick(now) {
  if (!S.playing) return;
  const end = S.flight.points.at(-1).t;
  if (S.last != null) S.t = Math.min(end, S.t + (now - S.last) * Number($("speed").value));
  S.last = now;
  updateFrame();
  if (S.t >= end) setPlaying(false); else requestAnimationFrame(tick);
}

// --- Live flights ---------------------------------------------------------------

async function liveJson(path) {
  const r = await fetch(new URL(path, LIVE));
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.error ?? (r.status === 404 ? "live data isn't available on this site" : `${r.status}`));
  return body;
}

/** Aircraft from the API (a search, or around a chart), listed to choose from. */
async function findLive(path, what, footprint) {
  const box = $("live-list");
  const run = ++S.runs.live;
  box.replaceChildren(el("p", "status", `Looking for aircraft ${what}…`));
  let body;
  try {
    body = await liveJson(path);
  } catch (e) {
    if (run === S.runs.live) box.replaceChildren(el("p", "status error", `Couldn't get live aircraft: ${e.message}`));
    return;
  }
  if (run !== S.runs.live) return;
  const aircraft = footprint ? onChart(body.aircraft, footprint) : body.aircraft;
  const offset = body.now - Date.now();
  const credit = el("p", "status");
  credit.append("Positions from ", link(body.source.name, body.source.url), ", reported by volunteers' receivers: some areas have few.");
  if (!aircraft.length) {
    box.replaceChildren(el("p", "status", `No aircraft reported ${what} right now.`), credit);
    return;
  }
  box.replaceChildren(
    el("p", "status", `${aircraft.length} aircraft ${what}`),
    ...aircraft.slice(0, 30).map((a) => {
      const b = el("button", "chart");
      b.append(
        el("span", "icao", label(a)),
        el("span", "title", [a.reg === label(a) ? null : a.reg, a.type].filter(Boolean).join(" · ") || "—"),
        el("span", "cover", altitudeText(a)),
        el("span", "cat", [a.gsKt == null ? null : `${Math.round(a.gsKt)} kt`, `seen ${ago(Date.now() + offset - a.t)} ago`].filter(Boolean).join(" · ")),
      );
      b.onclick = () => startLive(a, body);
      return b;
    }),
    credit,
  );
}

/** Follows an aircraft: its reports become the flight, the clock runs on now. */
function startLive(a, body) {
  stopLive();
  S.runs.live++;
  $("live-list").replaceChildren();
  const points = [];
  addFix(points, a);
  setFlight({ name: label(a), points, timed: true, live: true, aircraft: a }, null);
  S.live = {
    id: a.id,
    source: body.source,
    pollS: body.pollS ?? 15,
    offset: body.now - Date.now(),
    searchedAt: Date.now(),
    failures: 0,
    timer: null,
    shownAt: 0,
  };
  S.t = Date.now() + S.live.offset;
  showLiveInfo();
  schedulePoll();
  requestAnimationFrame(liveTick);
}

function stopLive(reason) {
  if (!S.live) return;
  clearTimeout(S.live.timer);
  S.live = null;
  if (S.flight?.live) {
    // What was flown stays on screen, without the clock running.
    S.flight.ended = reason ?? "Stopped following.";
    showLiveInfo();
  }
}

function schedulePoll() {
  const L = S.live;
  clearTimeout(L.timer);
  // Errors back off up to two minutes.
  const wait = L.pollS * 1000 * Math.min(8, 2 ** L.failures);
  L.timer = setTimeout(poll, wait);
}

async function poll() {
  const L = S.live;
  if (!L) return;
  clearTimeout(L.timer);
  if (document.hidden) return; // visibilitychange calls again
  let body;
  try {
    body = await liveJson(`aircraft/${encodeURIComponent(L.id)}`);
    L.failures = 0;
    L.error = null;
  } catch (e) {
    if (S.live !== L) return;
    L.failures++;
    L.error = e.message;
    showLiveInfo();
    schedulePoll();
    return;
  }
  if (S.live !== L) return;
  L.offset = body.now - Date.now();
  L.pollS = body.pollS ?? L.pollS;
  const a = body.aircraft.find((x) => x.id === L.id);
  const f = S.flight;
  if (a && addFix(f.points, a)) {
    f.aircraft = a;
    const p = f.points.at(-1);
    if (S.px) S.px.push(S.geo.toPixel(p));
    layer.querySelector(".trail")?.setAttribute("d", S.px ? path(S.px) : "");
    profile.cols = null;
    if (Date.now() - L.searchedAt > LIVE_RESEARCH_MS) {
      L.searchedAt = Date.now();
      findCharts({ quiet: true });
    }
  }
  if (body.now - f.points.at(-1).t > LOST_AFTER_MS) {
    stopLive(`No reports for ${Math.round(LOST_AFTER_MS / 60000)} minutes: it has landed or left receiver coverage.`);
    return;
  }
  showLiveInfo();
  schedulePoll();
}

function liveTick() {
  const L = S.live;
  if (!L) return;
  S.t = Date.now() + L.offset;
  updateFrame();
  // The report's age, once a second.
  if (Date.now() - L.shownAt > 1000) showLiveInfo();
  requestAnimationFrame(liveTick);
}

function showLiveInfo() {
  const f = S.flight;
  if (!f?.live) return;
  const a = f.aircraft, L = S.live;
  if (L) L.shownAt = Date.now();
  const age = (L ? Date.now() + L.offset : f.points.at(-1).t) - f.points.at(-1).t;
  const stale = age > 30000;
  const lines = [el("strong", null, [label(a), a.reg && a.reg !== label(a) ? a.reg : null, a.type].filter(Boolean).join(" · "))];
  if (L) {
    const state = el("div", "muted");
    const dot = el("span", `live-dot${stale ? " stale" : ""}`);
    state.append(dot, `Live · last report ${ago(age)} ago · ${f.points.length.toLocaleString()} report${f.points.length === 1 ? "" : "s"}`);
    lines.push(state);
    if (stale) lines.push(el("div", "note", `No report for ${ago(age)}: shown where it would be at its last speed and track, for up to a minute.`));
    if (L.error) lines.push(el("div", "note", `Couldn't reach live data (${L.error}); trying again.`));
  } else {
    lines.push(el("div", "muted", `${f.points.length.toLocaleString()} reports · ${clock(f.points[0].t)}–${clock(f.points.at(-1).t)} UTC`));
    lines.push(el("div", "note", f.ended));
  }
  const credit = el("div", "muted");
  const source = L?.source ?? f.source;
  if (source) credit.append("Positions from ", link(source.name, source.url));
  f.source = source;
  lines.push(credit);
  if (L) {
    const stop = el("button", "btn wide", "Stop following");
    stop.type = "button";
    stop.onclick = () => stopLive();
    lines.push(stop);
  }
  $("flight-info").replaceChildren(...lines);
}

// --- Traffic: every aircraft on the chart ----------------------------------------

const TRAFFIC_PREFS = "replay.traffic";

function trafficPrefs() {
  try { return JSON.parse(localStorage.getItem(TRAFFIC_PREFS)) ?? {}; } catch { return {}; }
}

function saveTrafficPrefs() {
  try {
    localStorage.setItem(TRAFFIC_PREFS, JSON.stringify({
      on: $("traffic").checked,
      hideGround: $("traffic-ground").checked,
      min: $("traffic-min").value,
      max: $("traffic-max").value,
    }));
  } catch { /* Only a convenience. */ }
}

function trafficWanted() {
  return $("traffic").checked && !!S.chart?.georef.footprint;
}

/** Starts, restarts (a new chart) or stops showing traffic. */
function setTraffic() {
  const T = S.traffic;
  clearTimeout(T.timer);
  T.run++;
  T.aircraft = [];
  T.error = null;
  T.failures = 0;
  T.at = null;
  for (const id of ["traffic-ground", "traffic-min", "traffic-max"]) $(id).disabled = !$("traffic").checked;
  drawTraffic();
  if (trafficWanted()) pollTraffic();
}

async function pollTraffic() {
  const T = S.traffic, run = T.run;
  clearTimeout(T.timer);
  if (document.hidden || !trafficWanted()) return; // visibilitychange calls again
  const footprint = S.chart.georef.footprint;
  const { lat, lon, nm } = areaAround(footprint);
  try {
    const body = await liveJson(`area?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&nm=${nm}`);
    if (run !== T.run) return;
    T.aircraft = onChart(body.aircraft, footprint).map((a) => ({ ...a, point: toPoint(a) }));
    T.offset = body.now - Date.now();
    T.pollS = body.pollS ?? T.pollS;
    T.source = body.source;
    T.at = body.now;
    T.failures = 0;
    T.error = null;
  } catch (e) {
    if (run !== T.run) return;
    T.failures++;
    T.error = e.message;
  }
  drawTraffic();
  T.timer = setTimeout(pollTraffic, T.pollS * 1000 * Math.min(8, 2 ** T.failures));
}

/** One marker per aircraft shown, labelled; placeTraffic moves them. */
function drawTraffic() {
  const T = S.traffic, box = $("traffic-layer");
  const on = trafficWanted();
  const shown = on ? trafficShown(T.aircraft, trafficFilter()) : [];
  const keep = new Set(shown.map((a) => a.id));
  for (const [id, el] of T.els) if (!keep.has(id)) { el.remove(); T.els.delete(id); }
  for (const a of shown) {
    let el = T.els.get(a.id);
    if (!el) {
      el = trafficMarker();
      T.els.set(a.id, el);
      box.append(el);
    }
    el.ac = a;
    el.classList.toggle("ground", a.onGround);
    el.lastChild.textContent = `${label(a)} ${altitudeText(a)}`;
    el.title = [label(a), a.reg !== label(a) ? a.reg : null, a.type, a.gsKt == null ? null : `${Math.round(a.gsKt)} kt`].filter(Boolean).join(" · ") + ". Click to follow.";
  }
  showTrafficStatus(shown.length);
  placeTraffic();
  if (shown.length && !T.loop) {
    T.loop = true;
    requestAnimationFrame(trafficTick);
  }
}

function trafficMarker() {
  const b = el("button", "ac");
  b.type = "button";
  b.innerHTML = `<svg viewBox="-17 -17 34 34" aria-hidden="true"><path d="M0 -15 L2.2 -6 L2.2 -2 L14 4 L14 7 L2.2 4 L1.8 11 L5.5 14 L5.5 16 L0 14.5 L-5.5 16 L-5.5 14 L-1.8 11 L-2.2 4 L-14 7 L-14 4 L-2.2 -2 L-2.2 -6 Z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span></span>`;
  b.onclick = () => {
    const T = S.traffic;
    startLive(b.ac, { source: T.source, pollS: T.pollS, now: Date.now() + T.offset });
  };
  return b;
}

/** Each aircraft where it is now: carried on from its report, like a followed one. */
function placeTraffic() {
  const T = S.traffic;
  if (!T.els.size) return;
  const now = Date.now() + T.offset;
  for (const el of T.els.values()) {
    const a = el.ac;
    const st = S.geo && a.id !== S.live?.id ? liveStateAt([a.point], now) : null;
    const p = st && S.geo.toPixel(st);
    // Off the page, or where the chart isn't to scale (a profile, an inset): left out.
    const inside = p && onSheet(p) && p[0] >= 0 && p[0] <= S.W && p[1] >= 0 && p[1] <= S.H && !notToScale(p[0] / S.W, p[1] / S.H);
    el.hidden = !inside;
    if (!inside) continue;
    const [x, y] = screenOf(p);
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.firstChild.style.transform = `rotate(${(a.trackDeg ?? 0) * Math.PI / 180 + S.geo.northAngle(st)}rad)`;
    el.classList.toggle("stale", st.ageMs > 60000);
  }
}

function trafficTick() {
  const T = S.traffic;
  if (!T.els.size) { T.loop = false; return; }
  // Following already moves everything each frame.
  if (!S.live) placeTraffic();
  requestAnimationFrame(trafficTick);
}

/** The filters as typed; a bound that isn't an altitude is marked and ignored. */
function trafficFilter() {
  const bound = (id) => {
    const ft = parseAltitude($(id).value);
    $(id).setAttribute("aria-invalid", String(Number.isNaN(ft)));
    return Number.isNaN(ft) ? null : ft;
  };
  return { hideGround: $("traffic-ground").checked, minFt: bound("traffic-min"), maxFt: bound("traffic-max") };
}

function showTrafficStatus(shown) {
  const T = S.traffic, box = $("traffic-status");
  box.hidden = !trafficWanted();
  if (box.hidden) return;
  if (T.at == null) {
    box.textContent = T.error ? `Couldn't get live aircraft: ${T.error}` : "Looking for aircraft on this chart…";
    return;
  }
  const { hideGround, minFt, maxFt } = trafficFilter();
  const ground = hideGround ? T.aircraft.filter((a) => a.onGround).length : 0;
  const band = T.aircraft.length - ground - shown;
  const parts = [`${shown} aircraft on this chart`];
  if (ground) parts.push(`${ground} on the ground hidden`);
  if (band > 0) {
    const ft = (v) => v >= 10000 && v % 100 === 0 ? `FL${String(v / 100).padStart(3, "0")}` : `${v.toLocaleString()} ft`;
    const where = minFt != null && maxFt != null ? `outside ${ft(minFt)}–${ft(maxFt)}` : minFt != null ? `below ${ft(minFt)}` : `above ${ft(maxFt)}`;
    parts.push(`${band} ${where} hidden`);
  }
  parts.push(`as of ${clock(T.at)} Z`);
  box.replaceChildren(parts.join(" · "), ". Click one to follow it.");
  if (T.error) box.append(` Couldn't update (${T.error}); trying again.`);
}

// --- Altitude profile ---------------------------------------------------------

const profile = { cols: null, width: 0, hover: null, top: 0, step: 0 };
const PROFILE_LEFT = 62; // room for the altitude labels

/** Highest altitude (ft) in each pixel column, so peaks survive at any width. */
function profileColumns(width) {
  const pts = S.flight.points, first = pts[0].t, span = pts.at(-1).t - first || 1;
  const cols = new Array(width).fill(null);
  for (const p of pts) {
    if (p.altM == null) continue;
    const c = Math.min(width - 1, Math.floor((p.t - first) / span * width));
    const ft = p.altM / 0.3048;
    cols[c] = cols[c] == null ? ft : Math.max(cols[c], ft);
  }
  // Fill columns between samples, so the area has no slits.
  let last = null;
  for (let i = 0; i < width; i++) {
    if (cols[i] == null) cols[i] = last; else last = cols[i];
  }
  const max = Math.max(0, ...cols.filter((v) => v != null));
  const step = [100, 200, 500, 1000, 2000, 2500, 5000, 10000, 20000].find((s) => max / s <= 3) ?? 50000;
  profile.top = Math.max(step, Math.ceil(max / step) * step);
  profile.step = step;
  return cols;
}

function drawProfile() {
  const canvas = $("profile");
  if (!S.flight || $("profile-box").hidden) return;
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const plotW = Math.max(1, Math.floor(w - PROFILE_LEFT));
  if (!profile.cols || profile.width !== plotW) {
    profile.cols = profileColumns(plotW);
    profile.width = plotW;
  }
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim(), muted = css.getPropertyValue("--muted").trim();
  const line = css.getPropertyValue("--line").trim(), text = css.getPropertyValue("--text").trim();
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const top = 8, bottom = h - 2;
  const y = (ft) => bottom - (ft / profile.top) * (bottom - top);

  // Recessive grid and labels.
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let v = 0; v <= profile.top; v += profile.step) {
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PROFILE_LEFT, Math.round(y(v)) + 0.5);
    ctx.lineTo(w, Math.round(y(v)) + 0.5);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(v ? `${v.toLocaleString()} ft` : "0", PROFILE_LEFT - 6, Math.min(bottom - 5, y(v)));
  }

  const pts = S.flight.points, first = pts[0].t, span = pts.at(-1).t - first || 1;
  const nowX = Math.min(plotW, (S.t - first) / span * plotW);
  const area = (from, to) => {
    ctx.beginPath();
    let open = false;
    for (let i = from; i < to; i++) {
      const v = profile.cols[i];
      if (v == null) continue;
      if (!open) { ctx.moveTo(PROFILE_LEFT + i, bottom); open = true; }
      ctx.lineTo(PROFILE_LEFT + i + 0.5, y(v));
    }
    if (open) { ctx.lineTo(PROFILE_LEFT + to, bottom); ctx.closePath(); }
  };
  const split = Math.max(0, Math.min(plotW, Math.round(nowX)));
  // Still to fly: faint; flown: stronger, with its outline.
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = accent;
  area(split, plotW);
  ctx.fill();
  ctx.globalAlpha = 0.5;
  area(0, split);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < split; i++) {
    const v = profile.cols[i];
    if (v == null) { pen = false; continue; }
    if (pen) ctx.lineTo(PROFILE_LEFT + i + 0.5, y(v)); else ctx.moveTo(PROFILE_LEFT + i + 0.5, y(v));
    pen = true;
  }
  ctx.stroke();

  // Now: a line through the plot and a dot at the aircraft's altitude.
  const nx = PROFILE_LEFT + nowX;
  ctx.strokeStyle = text;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(nx, top - 4);
  ctx.lineTo(nx, bottom);
  ctx.stroke();
  if (S.state?.altM != null) {
    ctx.beginPath();
    ctx.arc(nx, y(S.state.altM / 0.3048), 4.5, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.strokeStyle = css.getPropertyValue("--panel").trim();
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Hover: a crosshair, with time and altitude in the tip.
  const tip = $("profile-tip");
  if (profile.hover != null) {
    const hx = PROFILE_LEFT + profile.hover;
    ctx.strokeStyle = muted;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, top);
    ctx.lineTo(hx, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    const t = first + profile.hover / plotW * span;
    const st = stateAt(pts, t);
    tip.hidden = false;
    tip.textContent = `${S.flight.timed ? `${clock(t)} Z` : `+${duration(t - first, true)}`} · ${st.altM == null ? "—" : `${(Math.round(st.altM / 0.3048 / 10) * 10).toLocaleString()} ft`}`;
    tip.style.left = `${Math.max(60, Math.min(w - 60, hx))}px`;
  } else {
    tip.hidden = true;
  }
}

function wireProfile() {
  const canvas = $("profile");
  let seeking = false;
  const xOf = (e) => Math.max(0, Math.min(profile.width, e.clientX - canvas.getBoundingClientRect().left - PROFILE_LEFT));
  const seek = (e) => {
    const pts = S.flight.points;
    S.t = pts[0].t + xOf(e) / profile.width * (pts.at(-1).t - pts[0].t);
    updateFrame();
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (!S.flight || S.flight.live) return;
    seeking = true;
    canvas.setPointerCapture(e.pointerId);
    seek(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!S.flight) return;
    profile.hover = xOf(e);
    if (seeking) seek(e); else drawProfile();
  });
  canvas.addEventListener("pointerup", () => { seeking = false; });
  canvas.addEventListener("pointerleave", () => { profile.hover = null; drawProfile(); });
  new ResizeObserver(() => drawProfile()).observe(canvas);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => drawProfile());
}

// --- Wiring --------------------------------------------------------------------

function wireUi() {
  const file = $("file"), drop = $("drop");
  file.onchange = () => file.files[0] && loadFile(file.files[0]);
  for (const target of [drop, stage]) {
    target.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    target.addEventListener("dragleave", () => drop.classList.remove("over"));
    target.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      const f = e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
  }

  $("live-form").onsubmit = (e) => {
    e.preventDefault();
    const q = $("live-q").value.trim();
    if (q) findLive(`search?q=${encodeURIComponent(q)}`, `“${q.toUpperCase()}”`);
  };
  $("live-near").onclick = () => {
    const fp = S.chart?.georef.footprint;
    if (!fp) return;
    const { lat, lon, nm } = areaAround(fp);
    findLive(`area?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&nm=${nm}`, "on this chart", fp);
  };
  document.addEventListener("visibilitychange", () => {
    // Hidden tabs don't ask; on return, catch up at once.
    if (document.hidden) return;
    if (S.live) poll();
    if (trafficWanted()) pollTraffic();
  });
  const prefs = trafficPrefs();
  $("traffic").checked = !!prefs.on;
  $("traffic-ground").checked = !!prefs.hideGround;
  $("traffic-min").value = prefs.min ?? "";
  $("traffic-max").value = prefs.max ?? "";
  for (const id of ["traffic-min", "traffic-max"]) $(id).oninput = () => { saveTrafficPrefs(); drawTraffic(); };
  $("traffic").onchange = () => { saveTrafficPrefs(); setTraffic(); };
  $("traffic-ground").onchange = () => { saveTrafficPrefs(); drawTraffic(); };

  const icao = $("icao");
  icao.oninput = () => {
    const v = icao.value.trim().toUpperCase();
    if (v.length === 4 && S.aerodromes && !S.aerodromes.includes(v)) {
      $("charts").replaceChildren(el("p", "status", `No ${v} charts in ${S.edition?.name ?? "this edition"} can show a position.`));
    } else if (v.length === 4 || v.length === 0) {
      showCharts();
    }
  };

  $("play").onclick = () => setPlaying(!S.playing);
  $("seek").oninput = (e) => {
    const f = S.flight;
    if (!f) return;
    const first = f.points[0].t, last = f.points.at(-1).t;
    S.t = first + (last - first) * e.target.value / 1000;
    updateFrame();
  };
  $("follow").onchange = () => S.flight && updateFrame();
  $("zoom-in").onclick = () => zoomAt(1.6);
  $("zoom-out").onclick = () => zoomAt(1 / 1.6);
  $("zoom-fit").onclick = () => {
    if (!S.page) return;
    fitView();
    if ($("follow").checked && S.flight) updateFrame(); else applyView();
  };

  addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea") || !S.flight || S.flight.live) return;
    if (e.key === " ") { e.preventDefault(); setPlaying(!S.playing); }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const f = S.flight.points;
      S.t = Math.max(f[0].t, Math.min(f.at(-1).t, S.t + (e.key === "ArrowRight" ? 10000 : -10000)));
      updateFrame();
    }
  });

  wireProfile();

  // Drag to pan, wheel or pinch to zoom.
  const pointers = new Map();
  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") || !S.page) return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    stage.classList.add("dragging");
  });
  stage.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    if (pointers.size === 1) {
      S.view.x += e.clientX - prev[0];
      S.view.y += e.clientY - prev[1];
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      applyView();
    } else if (pointers.size === 2) {
      const [other] = [...pointers].filter(([id]) => id !== e.pointerId).map(([, p]) => p);
      const r = stage.getBoundingClientRect();
      const before = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
      const after = Math.hypot(e.clientX - other[0], e.clientY - other[1]);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (before > 0) zoomAt(after / before, (e.clientX + other[0]) / 2 - r.left, (e.clientY + other[1]) / 2 - r.top);
    }
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (!pointers.size) stage.classList.remove("dragging");
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);
  stage.addEventListener("wheel", (e) => {
    if (!S.page) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const follow = $("follow").checked && S.state;
    zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)), follow ? undefined : e.clientX - r.left, follow ? undefined : e.clientY - r.top);
  }, { passive: false });
  stage.addEventListener("dblclick", (e) => {
    const r = stage.getBoundingClientRect();
    zoomAt(2, e.clientX - r.left, e.clientY - r.top);
  });
  new ResizeObserver(() => { if (S.flight && $("follow").checked) updateFrame(); else placeMarker(); }).observe(stage);
}

// --- Helpers -------------------------------------------------------------------

function parseHash() {
  const m = /^#chart=([^/]+)\/([^/]+)\/([A-Z0-9]{4})\/(.+)$/.exec(location.hash);
  return m && { country: m[1], edition: m[2], icao: m[3], file: decodeURIComponent(m[4]) };
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function link(text, href) {
  const a = el("a", null, text);
  a.href = href;
  a.rel = "noopener";
  return a;
}

function setReadout(id, value, unit) {
  const dd = $(id);
  if (value == null) { dd.textContent = "—"; return; }
  dd.replaceChildren(String(value), ...(unit ? [" ", el("small", null, unit)] : []));
}

function clock(t) {
  return new Date(t).toISOString().slice(11, 19);
}

function duration(ms, withSeconds = false) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  if (withSeconds) return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s % 60).padStart(2, "0")}`;
  return h ? `${h} h ${m} min` : `${m} min`;
}

/** "4 s", "2:05": how long ago something was reported. */
function ago(ms) {
  return ms < 60000 ? `${Math.max(0, Math.round(ms / 1000))} s` : duration(ms, true);
}

function formatDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function loadScript(src, global) {
  if (window[global]) return Promise.resolve(window[global]);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve(window[global]);
    s.onerror = () => reject(new Error(`couldn't load ${src}`));
    document.head.append(s);
  });
}

init();
