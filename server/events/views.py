import uuid
from datetime import timedelta

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import status, throttling, viewsets
from rest_framework.decorators import (action, api_view, permission_classes,
                                       throttle_classes)
from rest_framework.exceptions import (APIException, NotFound,
                                       ValidationError)
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .importers.huckleberry import parse as parse_huckleberry
from .parsing import MAX_UTTERANCE, extract_events
from rest_framework.authtoken.models import Token
from rest_framework.permissions import AllowAny
from rest_framework.throttling import AnonRateThrottle

from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.validators import validate_email

from .mail import send_invite
from .models import (Baby, Event, Household, Invite, Membership,
                     segment_span)
from .serializers import (BabySerializer, EventSerializer, HouseholdSerializer,
                          InviteSerializer, RegisterSerializer, validate_payload)

MAX_IMPORT_BYTES = 5 * 1024 * 1024


def current_household(request):
    hh = Household.objects.filter(membership__user=request.user).first()
    if hh is None:
        raise NotFound("user belongs to no household")
    return hh


class HouseholdViewSet(viewsets.ModelViewSet):
    """Read and edit the caller's household. Not create, and not delete.

    A ModelViewSet gives both away for free, and neither is a feature here.
    POST minted a household with no members -- invisible even to whoever
    created it, and impossible to reach again. DELETE cascaded: one call took
    every baby and every event with it, permanently, with none of the care
    `BabyViewSet.perform_destroy` takes over a baby that merely has history.
    Households are made at setup; nothing in the app deletes one.
    """

    serializer_class = HouseholdSerializer
    permission_classes = [IsAuthenticated]
    http_method_names = ["get", "patch", "head", "options"]

    def get_queryset(self):
        return Household.objects.filter(membership__user=self.request.user).distinct()


class BabyViewSet(viewsets.ModelViewSet):
    serializer_class = BabySerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Baby.objects.filter(household__membership__user=self.request.user)

    def perform_create(self, serializer):
        serializer.save(household=current_household(self.request))

    def perform_destroy(self, instance):
        # Event.baby cascades. Deleting a baby who has history would silently
        # take every feed, diaper and sleep with it, which is never what the
        # button meant. Archiving hides them and keeps the record.
        if instance.events.exists():
            raise ValidationError(
                "this baby has logged events -- archive instead of deleting")
        instance.delete()


class ParserUnavailable(APIException):
    status_code = 503
    default_detail = ("Could not reach the parser just now. "
                      "Try again, or log it with the buttons.")


class ParseThrottle(throttling.UserRateThrottle):
    """Parsing is the only route that spends money per request.

    Accounts are invite-gated, so the exposure is a household member rather
    than a stranger -- but a phone stuck in a retry loop spends just as fast as
    a malicious one. The utterance-length cap bounds a single call; this bounds
    the loop.
    """
    scope = "parse"


class EventViewSet(viewsets.ModelViewSet):
    serializer_class = EventSerializer
    permission_classes = [IsAuthenticated]

    def get_serializer_context(self):
        return {**super().get_serializer_context(),
                "household": current_household(self.request)}

    def get_queryset(self):
        qs = Event.objects.for_user(self.request.user).live()
        p = self.request.query_params
        if baby := p.get("baby"):
            qs = qs.filter(baby=baby)
        if kind := p.get("type"):
            qs = qs.filter(type__in=kind.split(","))
        # `since`/`until` are instants; the client sends them derived from the
        # local day it is showing, so travel across zones stays correct.
        if since := p.get("since"):
            qs = qs.filter(started_at__gte=parse_datetime(since))
        if until := p.get("until"):
            qs = qs.filter(started_at__lt=parse_datetime(until))
        return qs.select_related("baby")

    def create(self, request, *args, **kwargs):
        """Idempotent create, so a queued offline write can flush twice safely."""
        given = request.data.get("id")
        if given:
            try:
                given = uuid.UUID(str(given))
            except (ValueError, AttributeError, TypeError):
                # Raised before any serializer runs, so it would otherwise
                # surface as a 500 from the queryset rather than a 400.
                raise ValidationError({"id": "must be a UUID"})
            existing = Event.objects.filter(pk=given).first()
            if existing is not None:
                if not Event.objects.for_user(request.user).filter(pk=given).exists():
                    raise ValidationError("that id belongs to another household")
                if existing.deleted_at:
                    # Deleted after the write was queued; the delete wins rather
                    # than the event coming back from the dead.
                    return Response(self.get_serializer(existing).data)
                if existing.ended_at and request.data.get("in_progress"):
                    # A queued "start a timer" write arriving after that timer was
                    # already finished. Applying it would set in_progress on an
                    # event with an end and trip the DB constraint.
                    return Response(self.get_serializer(existing).data)
                ser = self.get_serializer(existing, data=request.data, partial=True)
                ser.is_valid(raise_exception=True)
                ser.save()
                return Response(ser.data)
        # Only one feed can be in progress for a baby at a time. Two devices can
        # ask at once -- both parents tapping Nurse, or one phone asking before
        # its first poll has answered -- and the right response is to hand back
        # the timer that is already running rather than fork a second one.
        if request.data.get("in_progress") and request.data.get("type") == Event.FEED:
            with transaction.atomic():
                running = (
                    Event.objects.for_user(request.user).active()
                    .select_for_update()
                    .filter(type=Event.FEED, baby_id=request.data.get("baby"))
                    .first()
                )
                if running is not None:
                    return Response(self.get_serializer(running).data)
        return super().create(request, *args, **kwargs)

    def perform_create(self, serializer):
        serializer.save(household=current_household(self.request),
                        created_by=self.request.user)

    def perform_destroy(self, instance):
        from django.utils import timezone
        instance.deleted_at = timezone.now()  # soft delete, so sync propagates it
        instance.save(update_fields=["deleted_at", "updated_at"])

    @action(detail=False, methods=["get"])
    def active(self, request):
        """Every running timer in the household.

        Both phones poll this while a timer is going, which is what makes a
        feed startable on one device and stoppable on the other.
        """
        qs = Event.objects.for_user(request.user).active().select_related("baby")
        ctx = self.get_serializer_context()
        return Response({"events": EventSerializer(qs, many=True, context=ctx).data,
                         "now": timezone.now().isoformat()})

    @action(detail=True, methods=["post"])
    def timer(self, request, pk=None):
        """Apply one timer intent: {action: start|stop, side: L|R, at: <iso>}.

        Clients send intents, never computed totals. Two phones each PATCHing
        their own view of `right_sec` would clobber each other, and with two
        people passing a baby back and forth that is the normal case.
        """
        action_name = request.data.get("action")
        if action_name not in ("start", "stop"):
            raise ValidationError("action must be 'start' or 'stop'")
        side = request.data.get("side")
        if action_name == "start" and side not in ("L", "R"):
            raise ValidationError("starting requires side 'L' or 'R'")
        at = _timer_instant(request.data.get("at"))

        with transaction.atomic():
            ev = self._locked_active(pk)
            payload = dict(ev.payload or {})
            _bank_running_side(payload, at)
            if action_name == "start":
                payload["running_side"] = side
                payload["running_since"] = at.isoformat()
                payload["last_side"] = side
            ev.payload = payload
            ev.save(update_fields=["payload", "updated_at"])
        return Response(self.get_serializer(ev).data)

    @action(detail=True, methods=["post"])
    def finish(self, request, pk=None):
        """Stop the clock and save. `ended_at` set means it is no longer live."""
        at = _timer_instant(request.data.get("at"))
        with transaction.atomic():
            ev = self._locked_active(pk)
            payload = dict(ev.payload or {})
            _bank_running_side(payload, at)
            if at < ev.started_at:
                raise ValidationError("cannot finish before it started")
            ev.payload = payload
            # A feed spans the stretches the timer actually ran, not the screen
            # being open. Opening it five minutes early or saving five minutes
            # late must not tack those minutes onto either end.
            first, last = segment_span(payload)
            if first:
                ev.started_at = first
            ev.ended_at = last or at
            ev.in_progress = False
            ev.save(update_fields=["payload", "started_at", "ended_at",
                                   "in_progress", "updated_at"])
        return Response(self.get_serializer(ev).data)

    def _locked_active(self, pk):
        ev = (Event.objects.for_user(self.request.user).live()
              .select_for_update().filter(pk=pk).first())
        if ev is None:
            raise NotFound("no such event")
        if not ev.in_progress:
            raise ValidationError("event is not in progress")
        return ev

    # A router detail route would otherwise swallow `events/parse/` as a pk and
    # answer 405, so this is an action rather than a standalone path.
    @action(detail=False, methods=["post"], throttle_classes=[ParseThrottle])
    def parse(self, request):
        """Turn a sentence into draft events. Writes nothing.

        Returns the same body as `import_preview`, so the review screen renders
        either source unchanged and `import_commit` stays the only write path.
        """
        text = (request.data.get("text") or "").strip()
        if not text:
            raise ValidationError("nothing to parse")
        if len(text) > MAX_UTTERANCE:
            raise ValidationError(f"too long (max {MAX_UTTERANCE} characters)")

        # A correction turn carries the draft being corrected. It is the
        # client's copy, so it is re-validated below exactly like a fresh parse.
        draft = request.data.get("draft")
        if draft is not None and not isinstance(draft, list):
            raise ValidationError("'draft' must be a list of rows")

        hh = current_household(request)
        try:
            rows = extract_events(text, tz=hh.timezone, now=timezone.now(),
                                  scope=hh.pk, units=hh.units, draft=draft)
        except Exception:
            # Upstream trouble is not the caller's fault and must not read as one.
            raise ParserUnavailable()

        for row in rows:
            # The model's output goes through the same validator the CSV
            # importer uses. Nothing is trusted for coming from a model.
            row["errors"] = row.pop("time_errors", []) + row_errors(row)

        return Response({"tz": hh.timezone, "events": rows,
                         "invalid": sum(1 for r in rows if r["errors"]),
                         "already_imported": 0})

    @action(detail=False, methods=["get"])
    def latest(self, request):
        """One row per type -- powers the home screen's 'last feed 2h ago'."""
        out = {}
        qs = self.get_queryset()
        for kind in Event.TYPES:
            ev = qs.filter(type=kind).order_by("-started_at").first()
            if ev:
                out[kind] = EventSerializer(ev, context=self.get_serializer_context()).data
        return Response(out)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def import_preview(request):
    """Parse an uploaded export and return the rows WITHOUT saving anything.

    The client shows these for review and edit, then posts the (possibly
    corrected) rows to import_commit. Nothing is staged server-side: the parse is
    deterministic and cheap, so re-uploading is the recovery path.
    """
    upload = request.FILES.get("file")
    if not upload:
        raise ValidationError("no file uploaded (field name: 'file')")
    if upload.size > MAX_IMPORT_BYTES:
        raise ValidationError(f"file too large (max {MAX_IMPORT_BYTES // 1024 // 1024}MB)")

    tz = request.data.get("tz") or current_household(request).timezone
    try:
        rows = parse_huckleberry(upload.temporary_file_path()
                                 if hasattr(upload, "temporary_file_path")
                                 else _spool(upload), tz=tz)
    except (ValueError, KeyError, UnicodeDecodeError) as e:
        raise ValidationError(f"could not parse export: {e}")

    existing = set(
        Event.objects.for_user(request.user)
        .filter(id__in=[r["id"] for r in rows])
        .values_list("id", flat=True)
    )
    out = []
    for r in rows:
        row = {
            "id": str(r["id"]),
            "type": r["type"],
            "started_at": r["started_at"].isoformat(),
            "ended_at": r["ended_at"].isoformat() if r["ended_at"] else None,
            "tz": r["tz"],
            "payload": r["payload"],
            "notes": r["notes"],
            # Flags the review UI surfaces per row.
            "already_imported": r["id"] in existing,
            "needs_baby": r["type"] != Event.PUMP,
        }
        # Validated here, at preview, so the review list can show red warnings
        # before anything is committed.
        row["errors"] = row_errors(row)
        out.append(row)
    counts = {}
    for r in out:
        counts[r["type"]] = counts.get(r["type"], 0) + 1
    return Response({"count": len(out), "counts": counts,
                     "already_imported": len(existing),
                     "invalid": sum(1 for r in out if r["errors"]),
                     "tz": tz, "events": out})


def row_errors(row):
    """Everything wrong with one import row, as plain strings for the UI.

    Baby assignment is not checked here -- the baby is chosen at commit time,
    not at preview.
    """
    errors = []
    kind = row.get("type")
    if kind not in Event.TYPES:
        return [f"unknown event type {kind!r}"]
    try:
        validate_payload(kind, row.get("payload") or {})
    except ValidationError as e:
        errors.extend(str(d) for d in (e.detail if isinstance(e.detail, list) else [e.detail]))
    started = parse_datetime(row["started_at"]) if row.get("started_at") else None
    ended = parse_datetime(row["ended_at"]) if row.get("ended_at") else None
    if started is None:
        errors.append("missing or unparseable started_at")
    if row.get("ended_at") and ended is None:
        errors.append("unparseable ended_at")
    if started and ended and ended < started:
        errors.append("ends before it starts")
    return errors


MAX_CLOCK_SKEW = timedelta(minutes=5)


def _timer_instant(raw):
    """Parse a client-supplied timer instant, defaulting to now.

    Clients supply the moment a button was tapped so a queued offline tap keeps
    its real time -- but a wrong device clock must not write a nonsense event,
    so anything meaningfully in the future is refused.
    """
    if not raw:
        return timezone.now()
    at = parse_datetime(raw)
    if at is None:
        raise ValidationError("'at' must be an ISO-8601 datetime")
    if timezone.is_naive(at):
        raise ValidationError("'at' must include a timezone offset")
    if at > timezone.now() + MAX_CLOCK_SKEW:
        raise ValidationError("'at' is in the future -- check the device clock")
    return at


def _bank_running_side(payload, at):
    """Move the elapsed time of the running side into its accumulator.

    Mutates `payload` in place and leaves the timer paused.
    """
    side = payload.get("running_side")
    since = payload.get("running_since")
    payload.pop("running_side", None)
    payload.pop("running_since", None)
    if not side or not since:
        return
    started = parse_datetime(since)
    if started is None:
        return
    key = "right_sec" if side == "R" else "left_sec"
    # A clock that jumps backwards must never subtract time already banked.
    elapsed = max(0, int((at - started).total_seconds()))
    payload[key] = int(payload.get(key) or 0) + elapsed
    if elapsed:
        # Remember when, not just how long: one feed can be several stretches
        # with gaps, and the calendar draws the gaps differently.
        segments = list(payload.get("segments") or [])
        segments.append({"side": side, "from": started.isoformat(), "to": at.isoformat()})
        payload["segments"] = segments


def _spool(upload):
    import tempfile
    tmp = tempfile.NamedTemporaryFile(suffix=".csv", delete=False)
    for chunk in upload.chunks():
        tmp.write(chunk)
    tmp.close()
    return tmp.name


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def import_commit(request):
    """Save the rows the user kept selected.

    Per-row, not all-or-nothing: a bad row is skipped and reported by index, the
    rest still land. The response says exactly what saved and what didn't, and
    ids are content-derived, so re-previewing shows the true state and
    re-committing updates in place instead of duplicating.
    """
    household = current_household(request)
    events = request.data.get("events")
    if not isinstance(events, list) or not events:
        raise ValidationError("expected a non-empty 'events' list")

    baby = None
    if baby_id := request.data.get("baby"):
        baby = Baby.objects.filter(household=household, pk=baby_id).first()
        if baby is None:
            raise ValidationError("unknown baby for this household")

    # Ids are derived from content and supplied by the client, so two
    # households can arrive at the same one -- and `update_conflicts=True`
    # below would happily rewrite whichever row already holds it. The viewset's
    # create() has refused foreign ids since the offline outbox landed; this is
    # the same rule for the bulk path.
    incoming = []
    for row in events:
        try:
            incoming.append(uuid.UUID(str(row.get("id"))))
        except (ValueError, AttributeError, TypeError):
            pass
    foreign = set(
        Event.objects.filter(id__in=incoming)
        .exclude(household=household)
        .values_list("id", flat=True)
    )

    to_save, skipped = [], []
    for i, row in enumerate(events):
        errors = row_errors(row)
        try:
            if uuid.UUID(str(row.get("id"))) in foreign:
                errors.append("that id belongs to another household")
        except (ValueError, AttributeError, TypeError):
            errors.append("id must be a UUID")
        kind = row.get("type")
        row_baby = None if kind == Event.PUMP else baby
        if row_baby is None and kind != Event.PUMP:
            errors.append(f"{kind} needs a baby -- choose one before importing")
        if errors:
            skipped.append({"index": i, "id": row.get("id"), "errors": errors})
            continue
        to_save.append(Event(
            id=row["id"], household=household, baby=row_baby, type=kind,
            started_at=parse_datetime(row["started_at"]),
            ended_at=parse_datetime(row["ended_at"]) if row.get("ended_at") else None,
            tz=row.get("tz") or household.timezone,
            payload=row.get("payload") or {}, notes=row.get("notes") or "",
            created_by=request.user,
        ))

    if to_save:
        # Atomic over the rows that do save, so a DB error can't half-write them.
        with transaction.atomic():
            Event.objects.bulk_create(
                to_save,
                update_conflicts=True,
                update_fields=["baby", "type", "started_at", "ended_at", "tz",
                               "payload", "notes"],
                unique_fields=["id"],
            )
    return Response(
        {"saved": len(to_save), "skipped": skipped},
        status=status.HTTP_201_CREATED if to_save else status.HTTP_400_BAD_REQUEST,
    )


class InviteViewSet(viewsets.ModelViewSet):
    """Invites for the caller's household. Any member can invite; with two
    parents that is the right level, and the household is the blast radius."""

    serializer_class = InviteSerializer
    permission_classes = [IsAuthenticated]
    http_method_names = ["get", "post", "delete", "head", "options"]

    def get_queryset(self):
        return Invite.objects.filter(household__membership__user=self.request.user)

    def create(self, request, *args, **kwargs):
        email = (request.data.get("email") or "").strip()
        if not email:
            raise ValidationError({"email": "who should this go to?"})
        try:
            validate_email(email)
        except DjangoValidationError:
            raise ValidationError({"email": "that does not look like an email address"})

        invite = Invite.objects.create(
            household=current_household(request), created_by=request.user, email=email
        )
        sent = send_invite(invite)
        data = self.get_serializer(invite).data
        # A bounce must not lose the invite: the link is still in the response so
        # it can be passed on another way.
        data["email_sent"] = sent
        return Response(data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def resend(self, request, pk=None):
        invite = self.get_queryset().filter(pk=pk).first()
        if invite is None:
            raise NotFound("no such invite")
        if not invite.is_usable:
            raise ValidationError("that invite has already been used or has expired")
        data = self.get_serializer(invite).data
        data["email_sent"] = send_invite(invite)
        return Response(data)


class RegisterThrottle(AnonRateThrottle):
    # Codes are 24 random bytes, so guessing is hopeless; this just stops anyone
    # hammering the one unauthenticated write in the API. Kept loose enough that
    # two parents behind one home IP, fumbling a password, are not locked out.
    scope = "register"
    rate = "20/hour"


@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([RegisterThrottle])
def register(request):
    ser = RegisterSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    user = ser.save()
    token, _ = Token.objects.get_or_create(user=user)
    return Response({"token": token.key, "username": user.username},
                    status=status.HTTP_201_CREATED)

