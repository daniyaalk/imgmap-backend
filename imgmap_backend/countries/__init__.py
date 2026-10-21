"""Countries the backend publishes.

Each country with a Eurocontrol-style eAIP is one Country: its ICAO
prefixes, where editions are announced, page naming and chart file
conventions. To add one, write a module beside india.py and list it in
COUNTRIES. The app learns about it from countries.json; no app release.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ..eaip import describe_chart_by_name
from ..geo import LatLng


@dataclass(frozen=True)
class Country:
    id: str
    country: str
    country_code: str
    authority: str
    icao_prefixes: tuple[str, ...]
    map_center: LatLng
    find_editions: Callable
    """client -> [Edition], newest first."""
    page_prefix: str = ""
    language: str = "en-GB"
    chart_index_pages: Callable[[str], list[str]] = lambda icao: []
    describe_chart: Callable[[str, str], tuple[str, str]] = describe_chart_by_name

    def covers(self, icao: str) -> bool:
        return len(icao) == 4 and icao.startswith(self.icao_prefixes)

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "country": self.country,
            "countryCode": self.country_code,
            "authority": self.authority,
            "icaoPrefixes": list(self.icao_prefixes),
            "mapCenter": {"lat": self.map_center.lat, "lon": self.map_center.lon},
        }


def all_countries() -> list[Country]:
    from .india import INDIA

    return [INDIA]
