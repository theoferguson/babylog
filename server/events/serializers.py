from django.contrib.auth.models import User
from rest_framework import serializers

from .models import Baby, Event, Household, Membership

# Per-type payload rules. A dict, not a schema framework -- adding a type is a
# line here plus a form in the app.
#   key: (type, required?)
PAYLOAD_FIELDS = {
    Event.FEED: {
        "method": (str, True),          # breast | bottle
        "right_sec": (int, False),
        "left_sec": (int, False),
        "last_side": (str, False),      # L | R
        "contents": (str, False),
        "volume_ml": (float, False),
    },
    Event.DIAPER: {
        "pee": (str, False),            # small | medium | large
        "poo": (str, False),
        "color": (str, False),
        "consistency": (str, False),
    },
    Event.PUMP: {"left_ml": (float, False), "right_ml": (float, False)},
    Event.SLEEP: {},
    Event.GROWTH: {"weight_g": (float, False), "height_cm": (float, False),
                   "head_cm": (float, False)},
    Event.MED: {"name": (str, False), "dose": (float, False), "unit": (str, False)},
    Event.MILESTONE: {"label": (str, False)},
    Event.NOTE: {},
}
SIZES = {"small", "medium", "large"}


def validate_payload(kind, payload):
    """Raise ValidationError on unknown keys, wrong types, or bad enums.

    Unknown keys are rejected rather than ignored: a typo'd field that silently
    vanishes is how tracking data quietly goes wrong.
    """
    rules = PAYLOAD_FIELDS.get(kind)
    if rules is None:
        raise serializers.ValidationError(f"unknown event type {kind!r}")
    unknown = set(payload) - set(rules)
    if unknown:
        raise serializers.ValidationError(
            f"unknown {kind} payload field(s): {', '.join(sorted(unknown))}"
        )
    for key, (want, required) in rules.items():
        if key not in payload or payload[key] is None:
            if required:
                raise serializers.ValidationError(f"{kind} requires {key!r}")
            continue
        val = payload[key]
        if want is float and isinstance(val, int) and not isinstance(val, bool):
            val = float(val)
        if not isinstance(val, want) or isinstance(val, bool) != (want is bool):
            raise serializers.ValidationError(f"{kind}.{key} must be {want.__name__}")
        if want in (int, float) and val < 0:
            raise serializers.ValidationError(f"{kind}.{key} must not be negative")

    if kind == Event.FEED:
        if payload.get("method") not in ("breast", "bottle"):
            raise serializers.ValidationError("feed.method must be 'breast' or 'bottle'")
        if payload.get("last_side") not in (None, "L", "R"):
            raise serializers.ValidationError("feed.last_side must be 'L' or 'R'")
    if kind == Event.DIAPER:
        for k in ("pee", "poo"):
            if payload.get(k) not in (None, *SIZES):
                raise serializers.ValidationError(f"diaper.{k} must be one of {sorted(SIZES)}")
        if not (payload.get("pee") or payload.get("poo")):
            raise serializers.ValidationError("diaper needs at least one of pee/poo")
    return payload


class BabySerializer(serializers.ModelSerializer):
    class Meta:
        model = Baby
        fields = ["id", "name", "dob", "color", "archived"]


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "username", "email"]


class HouseholdSerializer(serializers.ModelSerializer):
    babies = BabySerializer(many=True, read_only=True)
    members = UserSerializer(many=True, read_only=True)

    class Meta:
        model = Household
        fields = ["id", "name", "units", "timezone", "babies", "members"]


class EventSerializer(serializers.ModelSerializer):
    duration_sec = serializers.ReadOnlyField()

    class Meta:
        model = Event
        fields = ["id", "baby", "type", "started_at", "ended_at", "tz", "payload",
                  "notes", "created_by", "updated_at", "deleted_at", "duration_sec"]
        read_only_fields = ["created_by", "updated_at"]

    def validate(self, attrs):
        kind = attrs.get("type", getattr(self.instance, "type", None))
        payload = attrs.get("payload", getattr(self.instance, "payload", {}) or {})
        validate_payload(kind, payload)

        start = attrs.get("started_at", getattr(self.instance, "started_at", None))
        end = attrs.get("ended_at", getattr(self.instance, "ended_at", None))
        if start and end and end < start:
            raise serializers.ValidationError("ended_at must not precede started_at")

        baby = attrs.get("baby", getattr(self.instance, "baby", None))
        if baby is None and kind != Event.PUMP:
            raise serializers.ValidationError(f"{kind} events need a baby")
        household = self.context["household"]
        if baby is not None and baby.household_id != household.id:
            raise serializers.ValidationError("baby belongs to another household")
        return attrs
