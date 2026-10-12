"""Read-only parser for locally installed HELI-X text recordings.

Independent format reader; no HELI-X dynamics code or model parameter tables.
Field order was checked against the installed recording serializer and numeric
consistency. Only fields needed for analysis are named. Unknown fields stay raw.
"""
from dataclasses import dataclass
from pathlib import Path
import math
import xml.etree.ElementTree as ET

SCHEMAS = {
    (3, 3, 3, 7, 9, 12, 8, 1): "extended",
    (3, 3, 3, 3, 6, 4, 7, 1): "legacy",
}


@dataclass(frozen=True)
class Recording:
    schema: str
    rows: list

    @property
    def frames(self):
        return len(self.rows)


def parse_recording(text: str) -> Recording:
    blocks, block = [], []
    # Records are eight numeric lines separated by a blank line. Preserve line
    # boundaries so a truncated record cannot silently shift every field.
    for number, line in enumerate(text.splitlines() + [""], 1):
        if not line.strip():
            if block:
                if len(block) != 8:
                    raise ValueError(f"Record ending at line {number} has {len(block)} lines, expected 8")
                blocks.append(block)
                block = []
            continue
        try:
            values = [float(v) for v in line.split()]
        except ValueError as exc:
            raise ValueError(f"Non-numeric value at line {number}") from exc
        if not all(math.isfinite(v) for v in values):
            raise ValueError(f"Non-finite value at line {number}")
        block.append(values)
    if not blocks:
        raise ValueError("Empty recording")
    shape = tuple(map(len, blocks[0]))
    if shape not in SCHEMAS:
        raise ValueError(f"Unknown record layout: {shape}")
    previous = -1
    for i, rows in enumerate(blocks):
        if tuple(map(len, rows)) != shape:
            raise ValueError(f"Mixed or truncated layout at frame {i}")
        stamp = rows[7][0]
        if stamp < 0 or not stamp.is_integer() or stamp <= previous:
            raise ValueError(f"Non-increasing/non-integer timestamp at frame {i}")
        previous = stamp
    return Recording(SCHEMAS[shape], blocks)


def read_recording(path: Path) -> Recording:
    return parse_recording(path.read_text(encoding="utf-8-sig"))


def metadata(path: Path) -> dict:
    xml_path = path.with_suffix(".xml")
    if not xml_path.exists():
        return {"model": None, "version": None, "revision": None}
    root = ET.fromstring(xml_path.read_text(encoding="utf-8-sig"))
    return {"model": root.findtext(".//HelicopterToLoad"),
            "version": root.findtext(".//Version"),
            "revision": root.findtext(".//HelixRevision")}
