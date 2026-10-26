"""The website in site/ (the flight replay page), served beside the data.

    python -m imgmap_backend.site publish      # upload site/ to R2 (env as for the pipeline)
    python -m imgmap_backend.site serve        # preview on http://localhost:8770/replay/

Pages read /v1/ and /pdf/ from their own origin, so the data needs no CORS.
The preview server passes those paths through to the live data.
"""

from __future__ import annotations

import argparse
import http.server
import mimetypes
from pathlib import Path

import requests

from .publish import R2Publisher

SITE = Path(__file__).resolve().parent.parent / "site"
_CACHE = "public, max-age=300"
_TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html; charset=utf-8", ".css": "text/css"}


def files() -> dict[str, Path]:
    """Object key → file. Each index.html is also stored under its folder's
    key ("replay/"), so the folder URL works on a bucket without index pages."""
    out = {}
    for path in sorted(SITE.rglob("*")):
        if path.is_file() and not path.name.startswith("."):
            key = path.relative_to(SITE).as_posix()
            out[key] = path
            if path.name == "index.html" and "/" in key:
                out[key[: -len("index.html")]] = path
    return out


def redirects() -> dict[str, bytes]:
    """"replay" → "replay/": the bucket can't redirect, so a page does."""
    return {
        key[:-1]: (
            f'<!doctype html><meta charset="utf-8"><title>Redirecting</title>'
            f'<meta http-equiv="refresh" content="0; url=/{key}"><a href="/{key}">/{key}</a>'
        ).encode()
        for key in files()
        if key.endswith("/")
    }


def content_type(path: Path) -> str:
    return _TYPES.get(path.suffix) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def publish(publisher: R2Publisher):
    for key, path in files().items():
        publisher.put(key, path.read_bytes(), {"ContentType": content_type(path), "CacheControl": _CACHE})
        print(f"published {key}")
    for key, page in redirects().items():
        publisher.put(key, page, {"ContentType": "text/html; charset=utf-8", "CacheControl": _CACHE})
        print(f"published {key} (redirect)")


def serve(port: int, upstream: str):
    cache: dict[str, tuple[int, str, bytes]] = {}  # spares the live host repeat fetches

    def fetch(path):
        if path not in cache:
            r = requests.get(upstream.rstrip("/") + path, timeout=60)
            if r.status_code != 200:
                return r.status_code, r.headers.get("Content-Type", "text/plain"), r.content
            cache[path] = (200, r.headers.get("Content-Type", "application/octet-stream"), r.content)
        return cache[path]

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(SITE), **kwargs)

        def do_GET(self):
            if self.path.startswith(("/v1/", "/pdf/")):
                status, ctype, body = fetch(self.path)
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                super().do_GET()

        def guess_type(self, path):
            return content_type(Path(path))

    print(f"http://localhost:{port}/replay/  (data from {upstream})")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("publish", help="upload site/ to the R2 bucket")
    s = sub.add_parser("serve", help="preview locally")
    s.add_argument("--port", type=int, default=8770)
    s.add_argument("--upstream", default="https://charts.daniyaalkhan.com/")
    args = p.parse_args()
    if args.command == "publish":
        publish(R2Publisher.from_env())
    else:
        serve(args.port, args.upstream)


if __name__ == "__main__":
    main()
