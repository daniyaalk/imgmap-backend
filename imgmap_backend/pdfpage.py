"""What georeferencing needs from a chart PDF: its text and small vector
shapes, positioned in a virtual pixel space (longest side 4096 px). No image
is rendered.

Results go to the app as fractions of the page, so this pixel space only
needs to be consistent here. It matches the app's old render size, keeping
pixel-based thresholds as they were tuned.
"""

from __future__ import annotations

import ctypes
import threading
from dataclasses import dataclass, field

import pypdfium2 as pdfium
import pypdfium2.raw as raw

LONG_SIDE = 4096

# PDFium is not thread-safe: one document at a time, process-wide.
_PDFIUM = threading.Lock()


@dataclass(frozen=True)
class Box:
    """Axis-aligned box in page pixels (y down)."""

    left: float
    top: float
    right: float
    bottom: float

    @property
    def width(self):
        return self.right - self.left

    @property
    def height(self):
        return self.bottom - self.top

    @property
    def cx(self):
        return (self.left + self.right) / 2

    @property
    def cy(self):
        return (self.top + self.bottom) / 2

    @property
    def shortest(self):
        return min(abs(self.width), abs(self.height))

    @property
    def longest(self):
        return max(abs(self.width), abs(self.height))

    @property
    def empty(self):
        return self.left >= self.right or self.top >= self.bottom

    def union(self, o: Box) -> Box:
        return Box(min(self.left, o.left), min(self.top, o.top), max(self.right, o.right), max(self.bottom, o.bottom))

    def overlaps(self, o: Box) -> bool:
        return self.right > o.left and o.right > self.left and self.bottom > o.top and o.bottom > self.top

    def inflate(self, d: float) -> Box:
        return Box(self.left - d, self.top - d, self.right + d, self.bottom + d)


@dataclass
class ChartText:
    """A run of neighbouring glyphs, with each character's box."""

    text: str
    boxes: list[Box]

    def bounds_of(self, start: int, end: int) -> Box:
        b = self.boxes[start]
        for i in range(start + 1, end):
            b = b.union(self.boxes[i])
        return b

    @property
    def bounds(self) -> Box:
        return self.bounds_of(0, len(self.text))


@dataclass
class ChartPage:
    width: float
    height: float
    texts: list[ChartText]
    points_per_pixel: float
    shapes: list[Box] = field(default_factory=list)
    rotation: int = 0
    """Quarter turns."""

    @property
    def longest(self):
        return max(self.width, self.height)

    @property
    def shortest(self):
        return min(self.width, self.height)


def extract_page(pdf_bytes: bytes, long_side: int = LONG_SIDE) -> ChartPage:
    with _PDFIUM:
        return _extract(pdf_bytes, long_side)


def _extract(pdf_bytes: bytes, long_side: int) -> ChartPage:
    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        if len(doc) == 0:
            raise ValueError("The PDF is empty.")
        page = doc[0]
        # Display size, rotation applied (as pdfrx's page.width/height).
        pw, ph = page.get_width(), page.get_height()
        rotation = (page.get_rotation() // 90) % 4
        scale = long_side / max(pw, ph)
        width, height = round(pw * scale), round(ph * scale)

        def to_pixels(left, bottom, right, top) -> Box:
            l, t, r, b = _rotate(left, top, right, bottom, rotation, pw, ph)
            s = height / ph
            return Box(l * s, (ph - t) * s, r * s, (ph - b) * s)

        tp = page.get_textpage()
        n = tp.count_chars()
        chars, boxes = [], []
        for i in range(n):
            chars.append(chr(raw.FPDFText_GetUnicode(tp.raw, i)))
            l, b, r, t = tp.get_charbox(i)
            boxes.append(to_pixels(l, b, r, t))
        texts = group_text("".join(chars), boxes)
        try:
            shapes = _shapes(page, to_pixels)
        except Exception:
            shapes = []  # Symbols are a bonus; text still works.
        return ChartPage(width, height, texts, 1 / scale, shapes, rotation)
    finally:
        doc.close()


def _rotate(left, top, right, bottom, rotation, pw, ph):
    """pdfrx's PdfRect.rotate: unrotated page space -> displayed page space."""
    swap = rotation & 1
    w = ph if swap else pw
    h = pw if swap else ph
    if rotation == 0:
        return left, top, right, bottom
    if rotation == 1:
        return bottom, w - left, top, w - right
    if rotation == 2:
        return w - right, h - bottom, w - left, h - top
    return h - top, right, h - bottom, left


def _shapes(page, to_pixels, max_points: float = 24) -> list[Box]:
    """Bounds of small path and form objects: map symbols such as waypoint
    triangles, navaid roses and runway thresholds."""
    found = []
    l, b, r, t = (ctypes.c_float() for _ in range(4))
    m = raw.FS_MATRIX()

    def visit(obj, transform):
        kind = raw.FPDFPageObj_GetType(obj)
        if kind not in (raw.FPDF_PAGEOBJ_PATH, raw.FPDF_PAGEOBJ_FORM):
            return
        if not raw.FPDFPageObj_GetBounds(obj, l, b, r, t):
            return
        x0, y0, x1, y1 = _apply_box(transform, l.value, b.value, r.value, t.value)
        w, h = x1 - x0, y1 - y0
        small = w <= max_points and h <= max_points and w + h >= 2
        if small:
            found.append((x0, y0, x1, y1))
        if kind == raw.FPDF_PAGEOBJ_PATH:
            return
        # A form's children are in its own space; its matrix maps to the parent's.
        if not raw.FPDFPageObj_GetMatrix(obj, m):
            return
        inner = _compose(transform, (m.a, m.b, m.c, m.d, m.e, m.f))
        for i in range(raw.FPDFFormObj_CountObjects(obj)):
            visit(raw.FPDFFormObj_GetObject(obj, i), inner)

    identity = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    for i in range(raw.FPDFPage_CountObjects(page.raw)):
        visit(raw.FPDFPage_GetObject(page.raw, i), identity)
    return [to_pixels(x0, y0, x1, y1) for x0, y0, x1, y1 in found]


def _compose(outer, inner):
    """`outer` applied after `inner`, PDF [a b c d e f] row-vector form."""
    a, b, c, d, e, f = outer
    ia, ib, ic, id_, ie, if_ = inner
    return (
        ia * a + ib * c,
        ia * b + ib * d,
        ic * a + id_ * c,
        ic * b + id_ * d,
        ie * a + if_ * c + e,
        ie * b + if_ * d + f,
    )


def _apply_box(tr, l, b, r, t):
    a, bb, c, d, e, f = tr
    xs, ys = [], []
    for x, y in ((l, b), (r, b), (l, t), (r, t)):
        xs.append(a * x + c * y + e)
        ys.append(bb * x + d * y + f)
    return min(xs), min(ys), max(xs), max(ys)


def group_text(text: str, rects: list[Box]) -> list[ChartText]:
    """Splits characters into runs of neighbouring glyphs.

    Word-processor PDFs often place glyphs separately, so a label such as
    `077°10'E` arrives in pieces; joining by geometry reassembles it.
    """
    runs: list[ChartText] = []
    chars: list[str] = []
    boxes: list[Box] = []

    def flush():
        s = "".join(chars)
        if s.strip():
            start, end = 0, len(s)
            while start < end and not s[start].strip():
                start += 1
            while end > start and not s[end - 1].strip():
                end -= 1
            runs.append(ChartText(s[start:end], boxes[start:end]))
        chars.clear()
        boxes.clear()

    last: Box | None = None
    for c, r in zip(text, rects):
        if c in "\n\r":
            flush()
            last = None
            continue
        blank = not c.strip() or r.empty
        if not blank and last is not None and not _adjacent(last, r):
            flush()
        chars.append(c)
        # Whitespace often has a zero box; give it its neighbour's.
        boxes.append((last or r) if blank else r)
        if not blank:
            last = r
    flush()
    return runs


def _adjacent(a: Box, b: Box) -> bool:
    size = max(a.width, a.height, b.width, b.height)
    dx = b.left - a.right if b.left > a.right else (a.left - b.right if a.left > b.right else 0.0)
    dy = b.top - a.bottom if b.top > a.bottom else (a.top - b.bottom if a.top > b.bottom else 0.0)
    return dx <= size * 0.9 and dy <= size * 0.9
