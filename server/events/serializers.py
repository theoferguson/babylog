from datetime import timedelta

from django.conf import settings as django_settings
from django.contrib.auth import password_validation
from django.contrib.auth.models import User
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import serializers

from .models import Baby, Event, Household, Invite, Membership

# Per-type payload rules. A dict, not a schema framework -- adding a type is a
# line here plus a form in the app.
#   key: (type, required?)
PAYLOAD_FIELDS = {
    Event.FEED: {
        "method": (str, True),          # breast | bottle
        "right_sec": (int, False),
        "left_sec": (int, False),
        "last_side": (str, False),      # L | R
        # Live timer state, owned by the server. Clients send intents to
        # /timer/, never these values.
        "running_side": (str, False),   # L | R, or absent when paused
        "running_since": (str, False),  # iso8601
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
        if payload.get("running_side") not in (None, "L", "R"):
            raise serializers.ValidationError("feed.running_side must be 'L' or 'R'")
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
    """Events, with per-type payload validation."""

    duration_sec = serializers.ReadOnlyField()
    # Declared explicitly because the model field is editable=False, which would
    # otherwise make DRF read-only it and silently discard the client's id. The
    # offline outbox depends on the client choosing the id: that is what makes a
    # replayed write an upsert instead of a duplicate.
    id = serializers.UUIDField(required=False)

    class Meta:
        model = Event
        fields = ["id", "baby", "type", "started_at", "ended_at", "tz", "payload",
                  "notes", "created_by", "updated_at", "deleted_at", "duration_sec",
                  "in_progress"]
        read_only_fields = ["created_by", "updated_at"]

    def update(self, instance, validated_data):
        """Moving a running feed's start time carries the running side with it.

        The total is time the timer actually ran, so pushing the start back ten
        minutes has to add ten minutes to whichever side was running -- otherwise
        the correction shows up in the start time and nowhere in the total.
        A paused feed has nothing running, so its total is unaffected, which is
        correct: no side was counting during that stretch.
        """
        new_start = validated_data.get("started_at")
        if new_start and instance.in_progress and new_start != instance.started_at:
            payload = dict(validated_data.get("payload") or instance.payload or {})
            since = payload.get("running_since")
            if since:
                started = parse_datetime(since)
                if started is not None:
                    shifted = started + (new_start - instance.started_at)
                    payload["running_since"] = shifted.isoformat()
                    validated_data["payload"] = payload
        return super().update(instance, validated_data)

    def validate(self, attrs):
        # The id is settable only at creation. Letting it through on update makes
        # Django UPDATE a row that no longer matches and then INSERT a copy --
        # a silent duplicate, not an error.
        if self.instance is not None:
            attrs.pop("id", None)

        kind = attrs.get("type", getattr(self.instance, "type", None))
        payload = attrs.get("payload", getattr(self.instance, "payload", {}) or {})
        validate_payload(kind, payload)

        if attrs.get("in_progress") and attrs.get("ended_at"):
            raise serializers.ValidationError("an in-progress event cannot have ended_at")

        start = attrs.get("started_at", getattr(self.instance, "started_at", None))
        end = attrs.get("ended_at", getattr(self.instance, "ended_at", None))
        if start and end and end < start:
            raise serializers.ValidationError("ended_at must not precede started_at")
        if start and start > timezone.now() + timedelta(minutes=5):
            raise serializers.ValidationError("started_at is in the future")

        # Nursing sides cannot add up to more than the feed itself lasted. This
        # is reachable two ways: dragging the start time forward on a running
        # timer, and typing minutes by hand in the editor. Neither should be able
        # to produce a feed whose sides exceed its own wall clock.
        if kind == Event.FEED and payload.get("method") == "breast" and start:
            sides = (payload.get("right_sec") or 0) + (payload.get("left_sec") or 0)
            finish = end or timezone.now()
            span = (finish - start).total_seconds()
            # A minute of slack: imported feeds are recorded to whole minutes.
            if sides > span + 60:
                raise serializers.ValidationError(
                    "the sides add up to more time than the feed lasted")

        baby = attrs.get("baby", getattr(self.instance, "baby", None))
        if baby is None and kind != Event.PUMP:
            raise serializers.ValidationError(f"{kind} events need a baby")
        household = self.context["household"]
        if baby is not None and baby.household_id != household.id:
            raise serializers.ValidationError("baby belongs to another household")
        return attrs


class InviteSerializer(serializers.ModelSerializer):
    created_by = serializers.CharField(source="created_by.username", read_only=True)
    accepted_by = serializers.CharField(source="accepted_by.username", read_only=True)
    is_usable = serializers.ReadOnlyField()
    link = serializers.SerializerMethodField()

    class Meta:
        model = Invite
        fields = ["id", "email", "link", "created_by", "created_at", "expires_at",
                  "sent_at", "accepted_by", "accepted_at", "is_usable"]
        read_only_fields = [f for f in fields if f != "email"]

    def get_link(self, obj):
        # Returned so the inviter can pass it on by hand if the email bounces.
        # The raw code is deliberately not exposed on its own.
        return obj.link(django_settings.PUBLIC_BASE_URL)


class RegisterSerializer(serializers.Serializer):
    """Account creation, gated by a single-use invite code.

    This is the only unauthenticated write in the API, so it validates hard: the
    code must exist, be unused and unexpired; the username must be free; and the
    password goes through Django's validators rather than a length check.
    """

    code = serializers.CharField()
    username = serializers.CharField(max_length=150)
    password = serializers.CharField(write_only=True)
    email = serializers.EmailField(required=False, allow_blank=True)

    def validate_username(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("choose a username")
        if User.objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError("that username is taken")
        return value

    def validate(self, attrs):
        invite = Invite.objects.filter(code=attrs["code"]).first()
        # One message for missing, used and expired alike: distinguishing them
        # would tell someone probing codes which guesses were real.
        if invite is None or not invite.is_usable:
            raise serializers.ValidationError({"code": "that invite is not valid"})
        password_validation.validate_password(attrs["password"])
        attrs["invite"] = invite
        return attrs

    @transaction.atomic
    def create(self, validated):
        invite = Invite.objects.select_for_update().get(pk=validated["invite"].pk)
        if not invite.is_usable:  # re-checked under the lock: codes are single-use
            raise serializers.ValidationError({"code": "that invite is not valid"})
        user = User.objects.create_user(
            username=validated["username"],
            password=validated["password"],
            email=validated.get("email", ""),
        )
        Membership.objects.create(user=user, household=invite.household)
        invite.accepted_by = user
        invite.accepted_at = timezone.now()
        invite.save(update_fields=["accepted_by", "accepted_at"])
        return user
