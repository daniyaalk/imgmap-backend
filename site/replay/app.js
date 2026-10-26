// Flight replay: a KML track drawn on a georeferenced AIP chart from this
// site's own /v1/ data, with the aircraft moving along it.

import * as pdfjs from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
import { Georeference, inPolygon, projection } from "./geo.js";
import { parseKml, stateAt } from "./kml.js";

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

const $ = (id) => document.getElementById(id);
const stage = $("stage"), layer = $("layer"), marker = $("marker");

const S = {
  flight: null,
  fileName: null,
  country: null,
  editions: [],
  edition: null,
  aerodromes: [],
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
  runs: { find: 0, open: 0 },
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
  $("edition").value = edition.id;
  const { aerodromes } = await fetchJson(`v1/${S.country.id}/${edition.id}/aerodromes.json`);
  if (S.edition !== edition) return;
  S.aerodromes = aerodromes.filter((a) => a.usable > 0).map((a) => a.icao);
  $("icaos").replaceChildren(...S.aerodromes.map((icao) => new Option(icao)));
  findCharts();
}

// --- Finding charts ----------------------------------------------------------

/** The aerodrome typed in the filter, if the edition has it. */
function aerodromeFilter() {
  const v = $("icao").value.trim().toUpperCase();
  return S.aerodromes.includes(v) ? v : null;
}

/** Every usable chart whose footprint the flight passes through. */
async function findCharts() {
  const run = ++S.runs.find;
  S.found = null;
  S.searched = 0;
  showCharts();
  if (!S.flight) return;
  const samples = sample(S.flight.points, COVERAGE_SAMPLES);
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
          if (n) found.push({ icao, chart: c, cover: n / samples.length, area: area(c.georef.footprint) });
        }
      } catch { /* One aerodrome missing doesn't stop the search. */ }
      if (run !== S.runs.find) return;
      S.searched++;
      showCharts();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (run !== S.runs.find) return;
  // Most of the flight first; among equals, the more detailed chart.
  S.found = found.sort((a, b) => b.cover - a.cover || a.area - b.area);
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
  if (S.flight) {
    if (!S.found) {
      box.replaceChildren(status(`Looking for charts this flight crosses… ${S.searched} of ${S.aerodromes.length} aerodromes`));
      return;
    }
    const found = icao ? S.found.filter((f) => f.icao === icao) : S.found;
    const where = icao ? ` ${icao}` : "";
    box.replaceChildren(
      found.length
        ? status(`${found.length}${where} chart${found.length === 1 ? "" : "s"} this flight crosses, with the share of the flight on each`)
        : status(`This flight doesn't cross any${where} chart placed on the map in ${S.edition.name}.`),
      ...found.slice(0, icao ? undefined : 40).map((f) => chartButton(f.icao, f.chart, f.cover)),
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

function chartButton(icao, chart, cover) {
  const b = el("button", "chart");
  b.dataset.key = `${icao}/${chart.file}`;
  b.classList.toggle("on", S.chart != null && b.dataset.key === `${S.chart.icao}/${S.chart.file}`);
  b.append(
    el("span", "icao", icao),
    el("span", "title", chart.title),
    el("span", "cover", cover == null ? "" : cover > 0 ? `${Math.max(1, Math.round(cover * 100))}%` : ""),
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
    title.title = `${chart.title} (${S.edition.name}). Positioned from ${chart.georef.method}, about ${Math.round(chart.georef.accuracyM)} m.`;
    buildOverlay();
    fitView();
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
  if (flight.timed) {
    const d = new Date(first);
    lines.push(el("div", "muted", `${d.toUTCString().slice(0, 16)} · ${clock(first)}–${clock(last)} UTC`));
  }
  lines.push(el("div", "muted", [
    `${duration(last - first)}`,
    `${pts.length.toLocaleString()} positions`,
    alts.length ? `up to ${Math.round(Math.max(...alts) / 0.3048).toLocaleString()} ft` : null,
  ].filter(Boolean).join(" · ")));
  if (!flight.timed) lines.push(el("div", "note", "This file has no times, so the flight is replayed at a steady 140 kt."));
  if (!alts.length) lines.push(el("div", "note", "This file has no altitudes."));
  info.replaceChildren(...lines);
  $("player").hidden = false;
  $("profile-box").hidden = !alts.length;
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
  const st = S.state = stateAt(f.points, S.t);
  if (st.trackDeg != null) S.rotation = st.trackDeg;
  const first = f.points[0].t, last = f.points.at(-1).t;
  $("seek").value = last > first ? Math.round((S.t - first) / (last - first) * 1000) : 0;
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
  const nts = (S.chart.georef.notToScale ?? []).some(([u1, v1, u2, v2]) =>
    u >= Math.min(u1, u2) && u <= Math.max(u1, u2) && v >= Math.min(v1, v2) && v <= Math.max(v1, v2));
  marker.classList.toggle("dim", off || nts);
  where.hidden = !(off || nts);
  where.textContent = off ? "Off this chart" : "In a part drawn not to scale: position approximate";
}

function setPlaying(on) {
  const f = S.flight;
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
  const nowX = (S.t - first) / span * plotW;
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
    if (!S.flight) return;
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

  const icao = $("icao");
  icao.oninput = () => {
    const v = icao.value.trim().toUpperCase();
    if (v.length === 4 && !S.aerodromes.includes(v)) {
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
    if (e.target.closest("input, select, textarea") || !S.flight) return;
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
