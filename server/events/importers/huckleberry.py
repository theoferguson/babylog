"""Parse a Huckleberry CSV export into babylog event dicts.

Deliberately has no Django import. The parsing is the whole job; the management
command that saves these is a thin wrapper written once models exist.

Huckleberry exports 8 generic columns and reuses them with a different meaning
per event type. There is no column->field mapping; each type needs its own
parser. See PLAN.md "The export format, decoded".

Run it directly to self-check against the synthetic fixture in events/testdata:
    python3 events/importers/huckleberry.py
"""
import csv, re, uuid
from collections import Counter
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo

NAMESPACE = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")
DEFAULT_TZ = "America/New_York"

# Huckleberry writes naive local times with no zone.
def _ts(s, tz):
    if not s:
        return None
    return datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=ZoneInfo(tz))

def _hhmm_secs(s):
    """'00:13R' -> 780. The column is HH:MM (verified: '00:21' on a 21-minute
    feed), NOT MM:SS. Returned in seconds to match the live timer; imported
    values are therefore always whole minutes."""
    if not s:
        return None
    m = re.fullmatch(r"(\d{1,2}):(\d{2})([LR])?", s.strip())
    if not m:
        raise ValueError(f"unparseable duration {s!r}")
    return (int(m.group(1)) * 60 + int(m.group(2))) * 60

ML_PER_OZ = 29.5735295625  # US fluid ounce

def _volume_ml(s):
    """'3.5oz' -> 103.51. Volumes are stored in ml; oz is a display preference.
    See Household.units."""
    if not s:
        return None
    m = re.fullmatch(r"([\d.]+)\s*oz", s.strip(), re.I)
    if not m:
        raise ValueError(f"unparseable volume {s!r}")
    return round(float(m.group(1)) * ML_PER_OZ, 2)

SIZES = {"small", "medium", "large"}

FIELDS = ("Type", "Start", "End", "Duration", "Start Condition",
          "Start Location", "End Condition", "Notes")

def _diaper_contents(s):
    """'Both, pee:medium poo:large' / 'Poo:small' / 'Pee:medium' -> (pee, poo)."""
    pee = poo = None
    for what, size in re.findall(r"(pee|poo)\s*:\s*(\w+)", s or "", re.I):
        size = size.lower()
        if size not in SIZES:
            raise ValueError(f"unknown size {size!r} in {s!r}")
        if what.lower() == "pee":
            pee = size
        else:
            poo = size
    if not (pee or poo):
        raise ValueError(f"no contents parsed from {s!r}")
    return pee, poo


def _feed(r, tz):
    if r["Start Location"] == "Breast":
        # Start Condition is always the right total, End Condition always the left.
        # Sides never overlap (verified: 0/98 rows), so each is an accumulator.
        right, left = _hhmm_secs(r["Start Condition"]), _hhmm_secs(r["End Condition"])
        # Column order is positional, not chronological, so which side ran last is
        # only knowable when exactly one side was used.
        last = "R" if (right and not left) else "L" if (left and not right) else None
        return dict(
            ended_at=_ts(r["End"], tz),
            payload={"method": "breast", "right_sec": right, "left_sec": left,
                     "last_side": last},
        )
    if r["Start Location"] == "Bottle":
        return dict(  # bottle feeds are instant -- 0/11 carry an End
            ended_at=None,
            payload={"method": "bottle", "contents": r["Start Condition"] or None,
                     "volume_ml": _volume_ml(r["End Condition"])},
        )
    raise ValueError(f"unknown feed location {r['Start Location']!r}")

def _diaper(r, tz):
    pee, poo = _diaper_contents(r["End Condition"])
    return dict(
        ended_at=None,
        # 'Duration' holds the colour on diaper rows. It is not a duration.
        payload={"pee": pee, "poo": poo,
                 "color": (r["Duration"] or None),
                 "consistency": (r["Start Condition"] or "").lower() or None},
    )

def _pump(r, tz):
    # Two independent volumes; the export never labels which side is which.
    # Always aggregate the total -- correct under either mapping.
    return dict(
        ended_at=_ts(r["End"], tz),
        payload={"left_ml": _volume_ml(r["Start Condition"]),
                 "right_ml": _volume_ml(r["End Condition"])},
    )

PARSERS = {"Feed": _feed, "Diaper": _diaper, "Pump": _pump}


def parse(path, tz=DEFAULT_TZ):
    """CSV path -> list of event dicts, oldest first."""
    out = []
    seen = Counter()
    with open(path, newline="") as fh:
        for i, r in enumerate(csv.DictReader(fh), 2):  # line 1 is the header
            kind = r["Type"]
            if kind not in PARSERS:
                raise ValueError(f"line {i}: unknown event type {kind!r}")
            try:
                ev = PARSERS[kind](r, tz)
            except ValueError as e:
                raise ValueError(f"line {i}: {e}") from e
            started = _ts(r["Start"], tz)
            # Deterministic id, so re-importing the same export is a no-op rather
            # than 224 duplicates. Keyed on the WHOLE row: two diapers logged in
            # the same minute (one pee, one poo) are distinct events, and
            # Start+End alone collides on them. The occurrence ordinal keeps
            # byte-identical rows distinct too -- dropping one would be silent
            # data loss, and the export gives us nothing to tell them apart.
            key = "|".join(r[c] or "" for c in FIELDS)
            seen[key] += 1
            out.append({
                "id": uuid.uuid5(NAMESPACE, f"{key}|{seen[key]}"),
                "type": {"Feed": "feed", "Diaper": "diaper", "Pump": "pump"}[kind],
                "started_at": started,
                "ended_at": ev["ended_at"],
                "tz": tz,
                "payload": {k: v for k, v in ev["payload"].items() if v is not None},
                "notes": r.get("Notes") or "",
            })
    out.sort(key=lambda e: e["started_at"])
    return out


if __name__ == "__main__":
    # Unit checks on the fiddly bits.
    assert _hhmm_secs("00:13R") == 13 * 60      # 13 minutes, not 13 seconds
    assert _hhmm_secs("01:05") == 65 * 60       # HH:MM -> 1h05m
    assert _hhmm_secs("") is None
    assert _volume_ml("3.5oz") == 103.51 and _volume_ml("0oz") == 0.0
    assert _diaper_contents("Both, pee:medium poo:large") == ("medium", "large")
    assert _diaper_contents("Poo:small") == (None, "small")
    assert _diaper_contents("Pee:medium") == ("medium", None)
    for bad, fn in [("00:1x", _hhmm_secs), ("3.5", _volume_ml), ("Poo:enormous", _diaper_contents)]:
        try:
            fn(bad); raise AssertionError(f"{bad!r} should not parse")
        except ValueError:
            pass

    csv_path = Path(__file__).resolve().parents[1] / "testdata" / "huckleberry-sample.csv"
    evs = parse(csv_path)
    by = lambda t: [e for e in evs if e["type"] == t]
    feed, diaper, pump = by("feed"), by("diaper"), by("pump")
    breast = [e for e in feed if e["payload"]["method"] == "breast"]
    bottle = [e for e in feed if e["payload"]["method"] == "bottle"]

    assert len(evs) == 13, len(evs)
    assert (len(feed), len(diaper), len(pump)) == (4, 6, 3)
    assert (len(breast), len(bottle)) == (3, 1)
    # Two diapers share a minute; ids must still be distinct or a re-import
    # would collapse them into one.
    assert len({e["id"] for e in evs}) == 13, "ids must be unique"
    assert len({e["started_at"] for e in diaper}) == 5, "fixture has a same-minute pair"
    assert all(e["started_at"].tzinfo for e in evs), "every timestamp must be zone-aware"
    assert all(e["ended_at"] is None or e["ended_at"] >= e["started_at"] for e in evs)

    # Breast feeds: all have an end, and the sides never exceed the wall clock.
    assert all(e["ended_at"] for e in breast)
    for e in breast:
        p = e["payload"]
        sides = (p.get("right_sec") or 0) + (p.get("left_sec") or 0)
        wall = (e["ended_at"] - e["started_at"]).total_seconds()
        assert sides <= wall + 60, f"overlap at {e['started_at']}: {sides}s > {wall}s"
        assert sides > 0, f"breast feed with no side recorded at {e['started_at']}"
    # HH:MM, not MM:SS -- '00:13R' is 13 minutes.
    assert breast[0]["payload"]["right_sec"] == 13 * 60
    # last_side is only knowable when exactly one side was used.
    assert [e["payload"].get("last_side") for e in breast] == [None, "R", "L"]

    assert all(e["ended_at"] is None for e in bottle), "bottle feeds are instant"
    assert bottle[0]["payload"]["volume_ml"] == 103.51  # 3.5oz
    assert all(e["payload"].get("pee") or e["payload"].get("poo") for e in diaper)
    assert sum(1 for e in diaper if e["notes"]) == 1

    total_ml = sum((e["payload"].get("left_ml") or 0) + (e["payload"].get("right_ml") or 0)
                   for e in pump)
    assert abs(total_ml - 7.25 * ML_PER_OZ) < 0.5, total_ml
    assert sum(1 for e in pump if e["ended_at"]) == 1

    assert parse(csv_path)[0]["id"] == evs[0]["id"], "ids must be stable"
    print(f"OK  {len(evs)} fixture events  "
          f"(feed {len(feed)} / diaper {len(diaper)} / pump {len(pump)}, "
          f"{total_ml:.0f}ml / {total_ml / ML_PER_OZ:.2f}oz pumped)")
