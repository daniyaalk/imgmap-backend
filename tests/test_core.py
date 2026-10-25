"""Tests ported from the app's Dart suite (georeference, projection,
grid_labels, fix_matching, aip, enroute)."""

import math

import numpy as np
import pytest

from imgmap_backend import georef as gr
from imgmap_backend.airspace import arc, frequencies_khz, level_ft, parse_airspace_page
from imgmap_backend.countries.india import describe_chart, parse_editions
from imgmap_backend.eaip import PointDirectory, node_text, parse_html, parse_point_page, parse_route_page
from imgmap_backend.geo import WEB_MERCATOR, ControlPoint, Georeference, LatLng, TransverseMercator
from imgmap_backend.pdfpage import Box, ChartPage, ChartText

UTM43 = TransverseMercator(43)


# --- Geo -------------------------------------------------------------------


def test_utm_known_value():
    z31 = TransverseMercator(31)
    x, y = z31.forward(45.0, 3.0)
    assert x == pytest.approx(500000, abs=0.01)
    assert y == pytest.approx(4982950.4, abs=0.5)
    assert TransverseMercator.utm_zone(77.1) == 43


@pytest.mark.parametrize("proj,p", [(WEB_MERCATOR, (28.5665, 77.1031)), (UTM43, (28.5665, 77.1031)), (UTM43, (12.95, 77.67))])
def test_projection_round_trip(proj, p):
    x, y = proj.forward(*p)
    lat, lon = proj.inverse(x, y)
    assert LatLng(float(lat), float(lon)).distance_to(LatLng(*p)) < 0.001


def chart_fn(deg=0.0, mpp=40.0, proj=WEB_MERCATOR):
    ox, oy = proj.forward(28.5, 77.1)
    t = math.radians(deg)

    def f(lat, lon):
        mx, my = proj.forward(lat, lon)
        x, y = (mx - ox) / mpp, -(my - oy) / mpp
        return 1500 + x * math.cos(t) - y * math.sin(t), 2000 + x * math.sin(t) + y * math.cos(t)

    return f


def test_georeference_similarity_and_affine():
    f = chart_fn(deg=23)
    pts = [ControlPoint(*f(la, lo), LatLng(la, lo)) for la, lo in [(28.5, 77.0), (28.7, 77.3)]]
    g = Georeference.fit(pts)
    assert not g.is_affine
    assert math.dist(g.to_pixel(LatLng(28.61, 77.21)), f(28.61, 77.21)) < 1e-6
    pts3 = pts + [ControlPoint(*f(28.45, 77.35), LatLng(28.45, 77.35))]
    g3 = Georeference.fit(pts3)
    assert g3.is_affine
    back = g3.to_latlng(*g3.to_pixel(LatLng(28.61, 77.21)))
    assert back.distance_to(LatLng(28.61, 77.21)) < 1e-3


def test_conformal_fit_survives_collinear_points():
    f = chart_fn(proj=UTM43)
    pts = [ControlPoint(*f(la, lo), LatLng(la, lo)) for la, lo in [(28.0, 76.8), (28.1, 76.95), (28.2, 77.1), (28.3, 77.2501)]]
    g = Georeference.fit(pts, UTM43, conformal=True)
    assert math.dist(g.to_pixel(LatLng(27.6, 77.3)), f(27.6, 77.3)) < 1


# --- eAIP text ---------------------------------------------------------------


def test_node_text_drops_deleted_and_keeps_numbers_whole():
    node = parse_html(
        "<div><td><del class='AmdtDeletedAIRAC'>93</del><ins class='AmdtInsertedAIRAC'>94</ins>.6 NM</td>"
        "<td>DME</td><td>AGG</td></div>"
    )
    assert node_text(node) == "94.6 NM DME AGG"


def test_point_page():
    page = """<html><body><table>
      <tr><td>84.</td><td>PABGU</td><td>283357.00N 0771703.05E</td></tr>
      <tr><td>AGRA</td><td>VOR/DME</td><td>AGG</td><td>112.000MHZ (57X)</td><td>As Required</td>
          <td>270926.21N 0775723.59E</td></tr>
      <tr><td>MAX 250 KIAS FL100</td><td>281139.09N 0772256.90E</td></tr>
    </table></body></html>"""
    d = parse_point_page(page)
    assert d["PABGU"][0].lat == pytest.approx(28 + 33 / 60 + 57 / 3600)
    assert d["AGG"][0].lon == pytest.approx(77 + 57 / 60 + 23.59 / 3600)
    assert "AGRA" not in d and "MAX" not in d and "FL100" not in d


def leg(td, limits="FL 460 FL 75 Class D 3200 FT"):
    return f"<tr><td></td><td></td><td>{td}</td><td>{limits}</td><td>20 NM</td><td></td><td>&#8595;</td><td></td></tr>"


def route_page(header, rows):
    out = f"<html><body><table><tr><td></td><td>{header}</td></tr>"
    for marker, point, lg in rows:
        out += f"<tr><td>{marker}</td><td>{point}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>"
        out += lg or ""
    return out + "</table></body></html>"


def test_route_page_with_amendments():
    page = route_page("A474 (DPN-MURUS)", [
        ("p", "DELHI DVOR DVOR/DME (DPN) 283401N 0770537E", leg("213/- 55.0 NM")),
        ("p", "DUDUM 274801N 0763121E", leg(
            "<del class='AmdtDeletedAIRAC'>214</del><ins>213</ins>/- <del class='AmdtDeletedAIRAC'>21</del><ins>20</ins>.0 NM",
            "FL 460 FL 75 Class D 4100 FT")),
        ("c", "IGOLU <del class='AmdtDeletedAIRAC'>273000N </del><ins>273123N </ins>0761850E", None),
    ])
    r = parse_route_page(page)[0]
    assert r.designator == "A474" and r.navigation_spec is None
    assert [p[1] or p[0] for p in r.points] == ["DPN", "DUDUM", "IGOLU"]
    assert r.points[2][2].lat == pytest.approx(27 + 31 / 60 + 23 / 3600)
    assert r.legs[1] == {"trk": 213, "d": 20.0, "u": "FL 460", "l": "FL 75", "cls": "D", "moca": 4100, "w": 20.0}
    q2 = parse_route_page(route_page("Q2 (RNAV 5) (DPN-BBB)", [("p", "DUDUM 274801N 0763121E", leg("1/- 1 NM")), ("p", "IGOLU 273123N 0761850E", None)]))
    assert q2[0].navigation_spec == "RNAV 5"


def test_india_editions_and_charts():
    home = """<ul><li><a href="https://aim-india.aai.aero/eaip/eaip-v2-10-2026/index-en-GB.html">
      eAIP India AMDT 10/2026 (Effective Date: 29 OCT 2026)</a></li>
      <li><a href="https://aim-india.aai.aero/eaip/eaip-v2-09-2026/index-en-GB.html">
      eAIP India AMDT 09/2026 (Effective Date: 01 OCT 2026)</a></li></ul>"""
    eds = parse_editions(home)
    assert [e.name for e in eds] == ["AMDT 10/2026", "AMDT 09/2026"]
    assert eds[1].effective == "2026-10-01"
    assert eds[1].base_url == "https://aim-india.aai.aero/eaip/eaip-v2-09-2026/"
    assert describe_chart("VIDP", "VIDP-SID-RNAV1-GNSS-RWY-09-AKRIB-DUDUM-6-E.pdf")[1] == "departure"
    assert describe_chart("VIDP", "VIDP-SID-RNAV1-GNSS-RWY-09-AKRIB-DUDUM-6-E-TABLE.pdf")[1] == "tabular"
    assert describe_chart("VOBL", "VOBL-SID-RWY-09L-RNAV1-GNSS-RWY 09L-RNAV1 (GNSS)-  ANIRO 8A-Table 1.pdf")[1] == "tabular"
    assert describe_chart("VOBL", "VOBL-SID-RWY-27L-RNAV1-GNSS-WAYPOINTS.pdf")[1] == "tabular"
    assert describe_chart("VIDP", "VIDP-ILS-LOC-RWY-27.pdf") == ("ILS LOC RWY 27", "approach")


def airspace_page(section, rows):
    """An ENR 2.1 page: a section heading, then airspaces, each a list of
    units (unit, call sign, frequencies)."""
    out = f"<html><body><table><tr><td>{section}</td></tr></table><table>"
    out += "<tr><td>Name, Lateral Limits Vertical Limits Class of airspace</td><td>Unit providing service</td>"
    out += "<td>Call sign Languages Hours of service</td><td>Frequency/Purpose</td><td>Remarks</td></tr>"
    for cell, units in rows:
        for i, (unit, callsign, freqs) in enumerate(units):
            first = f"<td rowspan='{len(units)}'>{cell}</td>" if i == 0 else ""
            out += f"<tr>{first}<td>{unit}</td><td>{callsign}</td><td>{freqs}</td><td></td></tr>"
    return out + "</table></body></html>"


def test_airspace_page():
    page = airspace_page("2.1.2 Control Area", [
        ("<p><em class='Bold'>Udaipur Control Area-</em></p><p>Area bounded by circular area of radius 30 NM "
         "centred on 243706N 0735334E.</p><p>FL 145 / 2700FT AMSL</p><p>D</p>",
         [("Udaipur Approach", "Udaipur Approach English HO", "120.85 MHZ")]),
        ("<p><em class='Bold'>Delhi- LDP1</em></p><p>Area bounded by - 283401N 0770537E; 272008N 0775711E; "
         "263513N 790228E; then Westward along the International Boundary of India with Nepal "
         "to 300550N 0783633E; 283401N 0770537E</p><p>FL 255 / 155FT AMSL</p><p>D</p>",
         [("Delhi ACC", "Delhi Control/Delhi Radar (RSR) English H24",
           "<del>120.5 MHZ</del><ins>120.9 MHZ</ins> 134.5 MHZ"),
          ("Delhi Radio", "Delhi Radio English H24", "10018 KHZ 3467 KHZ")]),
        ("<p><em class='Bold'>Goa Control Area- 6</em></p><p>Area bounded by lines joining points 160557N 0730501E; "
         "161504N 0724458E; 163534N 0730628E then along the counter clockwise arc of a circle of 150NM radius "
         "centred on 190530N 0725158E to 165308N 0740713E; 162028N 0742844E then along the counter clockwise arc "
         "of a circle of 50NM radius centred on 154433N 0735201E to point of origin.</p><p>FL 195 / FL 85</p><p>D</p>",
         [("MOPA APP", "Mopa Approach English H24", "123.8 MHZ 125 MHZ")]),
    ])
    udaipur, delhi, goa = parse_airspace_page(page)
    assert udaipur["n"] == "Udaipur Control Area" and udaipur["k"] == "cta"
    assert (udaipur["u"], udaipur["uft"], udaipur["l"], udaipur["lft"], udaipur["cls"]) == ("FL 145", 14500, "2700 FT AMSL", 2700, "D")
    ring = [LatLng(*p) for p in udaipur["rings"][0]]
    centre = LatLng(24 + 37 / 60 + 6 / 3600, 73 + 53 / 60 + 34 / 3600)
    assert all(c.distance_to(centre) == pytest.approx(30 * 1852, rel=0.01) for c in ring)
    assert udaipur["units"] == [{"n": "Udaipur Approach", "f": [120850], "cs": "Udaipur Approach", "h": "HO"}]

    # Along a border: drawn straight, and said to be approximate. The
    # longitude missing its leading zero still reads.
    assert delhi["approx"] and len(delhi["rings"][0]) == 4
    assert delhi["rings"][0][2] == [26.5869, 79.0411]
    assert delhi["l"] == "FL 155" and delhi["lft"] == 15500  # a misprint, corrected
    assert [u["f"] for u in delhi["units"]] == [[120900, 134500], [10018, 3467]]
    assert delhi["units"][0]["cs"] == "Delhi Control/Delhi Radar (RSR)"

    # Two arcs, the second closing the area.
    assert "approx" not in goa and len(goa["rings"][0]) > 10
    assert (goa["l"], goa["lft"]) == ("FL 085", 8500)
    assert goa["units"][0]["f"] == [123800, 125000]


def test_airspace_helpers():
    assert level_ft("FL 075") == 7500 and level_ft("UNL") is None and level_ft("GND") == 0
    assert level_ft("4 000 ft AMSL") == 4000
    assert frequencies_khz("124.45 124.5 MHZ 126.15 MHZ5670 KHZ 128.3 OTHER 3023 KHZ") == [124450, 124500, 126150, 5670, 128300, 3023]
    c = LatLng(19.0, 73.0)
    start = LatLng(19.5, 73.0)  # 30 NM north
    end = LatLng(19.0, 73.0 + 0.5 / math.cos(math.radians(19)))  # ~30 NM east
    cw = arc(start, end, c, 30, clockwise=True)
    ccw = arc(start, end, c, 30, clockwise=False)
    assert len(ccw) > 2 * len(cw)  # the long way round
    assert all(p.lon > 73 for p in cw)
    assert arc(start, LatLng(19.0, 74.5), c, 30, clockwise=True) is None  # end not on the circle


# --- Georeferencing on synthetic charts --------------------------------------


def text(s, cx, cy, glyph=20.0):
    w = glyph * 0.6
    left = cx - len(s) * w / 2
    return ChartText(s, [Box(left + i * w, cy - glyph / 2, left + (i + 1) * w, cy + glyph / 2) for i in range(len(s))])


def label(value, axis):
    d = int(math.floor(value))
    m = round((value - d) * 60)
    return f"{d}°{m}'0\"{'E' if axis == 'lon' else 'N'}"


def page(texts, shapes=(), w=3000, h=4000):
    return ChartPage(w, h, list(texts), 0.2, list(shapes))


def test_full_grid_with_stray_label():
    f = chart_fn(deg=3)
    texts = [text(label(lon, "lon"), *f(lat, lon)) for lon in (77.0, 77.1, 77.2) for lat in (28.2, 28.8)]
    texts += [text(label(lat, "lat"), *f(lat, lon)) for lat in (28.4, 28.5, 28.6) for lon in (76.9, 77.3)]
    texts.append(text("77°30'0\"E", 400, 3800))  # an inset's meridian
    r = gr.georeference_from_grid(page(texts))
    assert isinstance(r, gr.AutoGeoreference), r
    g = Georeference.fit(r.points, r.projection)
    assert math.dist(g.to_pixel(LatLng(28.55, 77.05)), f(28.55, 77.05)) < 0.5
    assert r.rms_m < 1


def test_one_edge_labels_with_stray_are_refused():
    f = chart_fn()
    texts = [text(label(lon, "lon"), *f(28.2, lon)) for lon in (77.0, 77.1, 77.2)]
    texts += [text(label(lat, "lat"), *f(lat, 76.9)) for lat in (28.4, 28.5, 28.6)]
    texts.append(text("77°30'0\"E", 400, 3800))
    assert isinstance(gr.georeference_from_grid(page(texts)), gr.Failure)


def test_scale_bar_and_printed_scale():
    ts = [text(str(v), 1000 + v * 100, 3900) for v in (0, 5, 10, 15)] + [text("NM", 2700, 3900)]
    assert gr.scale_bar_mpp(ts) == pytest.approx(18.52)
    assert gr.printed_scale("SCALE:1:450,000") == 450000
    assert gr.printed_scale("SCALE:1:500,0000") is None
    disagree = ts + [text("SCALE 1:200,000", 1500, 3800)]
    assert isinstance(gr.chart_scale(page(disagree)), gr.Failure)


FIXES = {
    "PABGU": LatLng(28.5658, 77.2842),
    "DP421": LatLng(28.3393, 77.2859),
    "DAGUL": LatLng(28.2454, 77.1967),
    "DUDUM": LatLng(27.8003, 76.5225),
    "AKRIB": LatLng(27.4169, 76.7989),
    "DP645": LatLng(28.2003, 77.1003),
}


def test_named_fixes_reject_a_displaced_one():
    f = chart_fn(deg=0.9, mpp=45, proj=UTM43)
    texts, shapes = [], []
    for name, p in FIXES.items():
        x, y = f(p.lat, p.lon)
        if name == "DUDUM":  # behind a NOT TO SCALE break
            x, y = x - 300, y + 120
        shapes.append(Box(x - 30, y - 29, x + 30, y + 29))
        texts.append(text(name, x + 130, y - 40, glyph=40))
        shapes.append(Box(x + 70, y - 59, x + 110, y - 21))  # a dash across the label
    texts.append(text("DUDUM 6E", 2600, 150, glyph=40))
    d = PointDirectory()
    for n, p in FIXES.items():
        d.add(n, p)
    d.add("DAGUL", LatLng(12.9, 80.1))  # a clashing name far away
    r = gr.georeference_from_fixes(page(texts, shapes, 2900, 4096), d)
    assert isinstance(r, gr.AutoGeoreference), r
    assert r.conformal and len(r.points) == 5
    assert all(p.pos != FIXES["DUDUM"] for p in r.points)
    g = Georeference.fit(r.points, r.projection, conformal=True)
    assert math.dist(g.to_pixel(LatLng(28.0, 76.9)), f(28.0, 76.9)) < 1


def test_not_to_scale_detected():
    areas = gr.not_to_scale_areas([text("N O T  T O  S C A L E", 600, 900)])
    assert len(areas) == 1 and areas[0].cx == pytest.approx(600, abs=1)
