"""Turn a spoken sentence into draft events. Nothing here writes.

The model proposes rows; `views.parse_text` validates them and hands them to
the review screen, and only `import_commit` -- reached by a human tap -- ever
writes. So the job of this module is narrow: produce candidate rows, and make
the ones that are wrong *visibly* wrong rather than plausibly wrong.
"""
import json
import os
import uuid
from datetime import timedelta
from zoneinfo import ZoneInfo

from django.utils.dateparse import parse_datetime

from .models import Event

MAX_UTTERANCE = 600          # a pasted novel is not a feed
MAX_ROWS = 10                # one sentence does not describe a whole day
FUTURE_GRACE = timedelta(minutes=5)
PAST_LIMIT = timedelta(days=7)

# A stable namespace so the same sentence yields the same ids. A retried
# request the server already completed must upsert, not duplicate.
NAMESPACE = uuid.UUID("5f6c4e6a-0f1a-4a6b-9c2e-1d3b7a8e0c11")


# What a person is allowed to describe out loud.
#
# Deliberately an allowlist, not `PAYLOAD_FIELDS` minus a denylist. That dict
# also holds server-owned timer state -- `running_side`, `running_since`,
# `segments` -- which `validate_payload` accepts as legitimate feed keys, and
# `import_commit` builds `Event(...)` directly without running
# `EventSerializer.validate`. Mirror the dict and a model could author nursing
# stretches nobody timed, unclamped, straight onto the calendar. Subtraction
# would also silently admit any field added later; this way new fields are
# excluded until someone opts them in.
SPOKEN_FIELDS = {
    Event.FEED: ["method", "left_sec", "right_sec", "volume_ml", "contents"],
    Event.DIAPER: ["pee", "poo", "color", "consistency"],
    Event.PUMP: ["left_ml", "right_ml"],
    Event.SLEEP: [],
    Event.NOTE: [],
}
SPOKEN_TYPES = list(SPOKEN_FIELDS)

# Field -> JSON type, for the flat schema below.
_JSON_TYPE = {
    "method": "string", "contents": "string", "pee": "string", "poo": "string",
    "color": "string", "consistency": "string",
    "left_sec": "integer", "right_sec": "integer",
    "volume_ml": "number", "left_ml": "number", "right_ml": "number",
}
_ALL_SPOKEN = sorted({f for fields in SPOKEN_FIELDS.values() for f in fields})


def schema():
    """The strict JSON schema the model generates into.

    Flat on purpose: a root-level union of per-type payloads fights strict
    mode. Under `strict` every key must appear in `required`, so optional
    becomes a union with null -- which means the model emits every payload key
    on every row and `_clean` strips the ones that do not belong.
    """
    payload = {
        "type": "object",
        "additionalProperties": False,
        "properties": {f: {"type": [_JSON_TYPE[f], "null"]} for f in _ALL_SPOKEN},
        "required": _ALL_SPOKEN,
    }
    event = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "type": {"type": "string", "enum": SPOKEN_TYPES},
            "started_at": {"type": "string",
                           "description": "ISO-8601 with offset"},
            "ended_at": {"type": ["string", "null"]},
            "notes": {"type": ["string", "null"]},
            "payload": payload,
        },
        "required": ["type", "started_at", "ended_at", "notes", "payload"],
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {"events": {"type": "array", "items": event}},
        "required": ["events"],
    }


SYSTEM = """\
You turn a parent's spoken note about their baby into structured events.

Rules:
- Emit one event per thing that happened. "Fed 20 minutes then a wet diaper" \
is two events.
- Times are relative to the current time given below, in the stated timezone. \
Return ISO-8601 with an offset. If no time is mentioned, use the current time.
- Nursing: put the minutes on left_sec/right_sec as SECONDS, and set \
method="breast". A bottle sets method="bottle" and volume_ml.
- pee and poo are one of: small, medium, large.
- Never invent a detail that was not said. Leave a field null instead.
- If the note describes nothing loggable, return an empty events list.
"""


def _prompt(text, tz, now, units, draft=None):
    when = now.astimezone(ZoneInfo(tz))
    ctx = (f"Current time: {when.isoformat()} ({tz})\n"
           f"Volumes are entered in {'ounces' if units == 'imperial' else 'millilitres'}"
           f" but you must return volume_ml and left_ml/right_ml in MILLILITRES.\n")
    msgs = [{"role": "system", "content": SYSTEM + "\n" + ctx}]
    if draft is not None:
        # A correction turn: the model revises the whole draft rather than
        # emitting a patch, so the result is always a complete set of rows the
        # human then re-reads.
        msgs.append({"role": "user", "content":
                     "The current draft is:\n" + json.dumps(draft, default=str)
                     + "\n\nApply this correction and return the full revised draft."})
    msgs.append({"role": "user", "content": text})
    return msgs


def _completion(messages):
    """The only call that leaves the process. Patched in tests."""
    from openai import OpenAI

    model = os.environ.get("OPENAI_MODEL")
    if not model:
        # No default on purpose: a model name baked into the repo goes stale
        # and the wrong one fails in ways that look like prompt problems.
        raise RuntimeError("OPENAI_MODEL is not set")
    # Bounded, so a hung upstream cannot pin a gunicorn worker -- there are
    # only 2x4 of them and the nurse screen polls every 3s during a feed.
    client = OpenAI(timeout=float(os.environ.get("OPENAI_TIMEOUT", "25")))
    res = client.chat.completions.create(
        model=model,
        messages=messages,
        response_format={
            "type": "json_schema",
            "json_schema": {"name": "events", "strict": True, "schema": schema()},
        },
    )
    return json.loads(res.choices[0].message.content)


def extract_events(text, *, tz, now, scope, units="metric", draft=None):
    """Draft rows for one utterance. Never raises on model output.

    `scope` is the household. It belongs in the id because these are derived
    from content: without it, two households both saying "wet diaper" mint the
    same uuid5, and a commit from one would land on the other's row.
    """
    body = _completion(_prompt(text, tz, now, units, draft))
    rows = (body or {}).get("events") or []
    out = []
    for i, raw in enumerate(rows[:MAX_ROWS]):
        row = _clean(raw, tz=tz, now=now)
        if row is None:
            continue
        row["id"] = str(uuid.uuid5(NAMESPACE, f"{scope}|{text}|{i}"))
        out.append(row)
    return out


def _clean(raw, *, tz, now):
    """Strip everything the model should not have said, keep the rest.

    Cross-type keys are the reason this is mandatory: `validate_payload` skips
    a key that is None, so a null on a type's own optional field is harmless,
    but `pee: null` on a feed is an unknown key for `feed` and fails. The flat
    schema forces exactly that on every row.
    """
    if not isinstance(raw, dict):
        return None
    kind = raw.get("type")
    if kind not in SPOKEN_FIELDS:
        return None

    allowed = SPOKEN_FIELDS[kind]
    src = raw.get("payload") or {}
    payload = {k: src[k] for k in allowed if src.get(k) is not None}

    # Derived, not taken from the model: which side was nursed last is timer
    # state, and for a described feed it is simply the only side with time on
    # it. Ambiguous when both ran, so it stays unset.
    if kind == Event.FEED and payload.get("method") == "breast":
        sides = [s for s in ("left_sec", "right_sec") if payload.get(s)]
        if len(sides) == 1:
            payload["last_side"] = "L" if sides[0] == "left_sec" else "R"

    row = {
        "type": kind,
        "started_at": raw.get("started_at"),
        "ended_at": raw.get("ended_at") or None,
        "tz": tz,
        "payload": payload,
        "notes": (raw.get("notes") or "")[:500],
        "already_imported": False,
        "needs_baby": kind != Event.PUMP,
    }
    row["time_errors"] = _time_errors(row, now)
    return row


def _time_errors(row, now):
    """A model must never be the thing that decides what 'today' means."""
    errors = []
    started = parse_datetime(row["started_at"] or "")
    if started is None:
        return ["could not work out when this happened"]
    if started.tzinfo is None:
        return ["a time without a timezone is not a time"]
    if started > now + FUTURE_GRACE:
        errors.append("that time is in the future")
    if started < now - PAST_LIMIT:
        errors.append("that is more than a week ago -- check the date")
    return errors
