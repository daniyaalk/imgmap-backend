"""AIP India, published by the Airports Authority of India.

The home page links each edition as eaip/eaip-v2-MM-YYYY/ next to text like
"eAIP India AMDT 09/2026 (Effective Date: 01 OCT 2026)". Section pages are
named IN-ENR 4.4-en-GB.html; each aerodrome's charts are listed in
eAIP/AD 2.1<ICAO>_BChart.html.
"""

import re
from datetime import date
from urllib.parse import urljoin

from ..eaip import Edition, node_text, parse_html
from ..geo import LatLng
from . import Country

HOME = "https://aim-india.aai.aero/"

_MONTHS = {m: i + 1 for i, m in enumerate("JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split())}


def parse_editions(home_page: str, home: str = HOME) -> list[Edition]:
    """Editions announced on the AAI home page, newest first."""
    doc = parse_html(home_page)
    link = re.compile(r"eaip/(eaip-v2-(\d{2})-(\d{4}))/")
    date_re = r"Effective Date:\s*(\d{1,2})\s+([A-Z]{3})\s+(\d{4})"
    found = {}
    for a in doc.iter("a"):
        m = link.search(a.get("href") or "")
        if not m:
            continue
        parent = a.getparent()
        context = node_text(a) + " " + (node_text(parent) if parent is not None else "")
        number = f"{m.group(2)}/{m.group(3)}"
        d = re.search(r"AMDT\s*" + re.escape(number) + r"\s*\(" + date_re, context, re.I) or re.search(
            date_re, node_text(a), re.I
        )
        if not d:
            continue
        month = _MONTHS.get(d.group(2).upper())
        if not month:
            continue
        eid = f"{m.group(3)}-{m.group(2)}"
        found[eid] = Edition(
            id=eid,
            name=f"AMDT {number}",
            effective=date(int(d.group(3)), month, int(d.group(1))).isoformat(),
            base_url=urljoin(home, f"eaip/{m.group(1)}/"),
        )
    return sorted(found.values(), key=lambda e: e.effective, reverse=True)


def describe_chart(icao: str, file_name: str) -> tuple[str, str]:
    """AAI file names read like VIDP-SID-RNAV1-GNSS-RWY-09-AKRIB-DUDUM-6-E.pdf."""
    stem = re.sub(r"\.pdf$", "", file_name, flags=re.I)
    if stem.upper().startswith(icao + "-"):
        stem = stem[len(icao) + 1:]
    u = stem.upper()

    def has(p):
        return re.search(p, u) is not None

    if has(r"(^|-)\s*(TABLE|CODING|WAYPOINTS)(-|\s|\d|\(|$)"):
        cat = "tabular"
    elif has(r"^SID\b"):
        cat = "departure"
    elif has(r"^STAR\b"):
        cat = "arrival"
    elif has(r"^ADC\b"):
        cat = "aerodrome"
    elif has(r"^PDC\b"):
        cat = "parking"
    elif has(r"^(TWY|LVP|ILS-CAT-[I]+-CRTC)"):
        cat = "ground"
    elif has(r"^(AOC|PATC|TATFP|ATC-SMAC|MSA)"):
        cat = "terrain"
    elif has(r"^(ILS|LOC|VOR|NDB|RNP|RNAV|GLS|DME|VISUAL)"):
        cat = "approach"
    elif has(r"^(TORA|LDA|ASDA|TODA)"):
        cat = "tabular"
    else:
        cat = "other"
    return stem.replace("-", " "), cat


INDIA = Country(
    id="in-aai",
    country="India",
    country_code="IN",
    authority="AAI",
    icao_prefixes=("VA", "VE", "VI", "VO"),
    map_center=LatLng(22, 80),
    page_prefix="IN-",
    find_editions=lambda client: parse_editions(client.text(HOME)),
    chart_index_pages=lambda icao: [f"AD 2.1{icao}_BChart.html", f"AD 2.1{icao}_TChart.html"],
    describe_chart=describe_chart,
)
