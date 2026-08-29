import uuid

from django.conf import settings
from django.db import models

ML_PER_OZ = 29.5735295625
G_PER_LB = 453.59237
CM_PER_IN = 2.54


class Household(models.Model):
    """The family. Tenancy boundary for everything else."""

    METRIC, IMPERIAL = "metric", "imperial"

    name = models.CharField(max_length=100)
    # Canonical storage is ALWAYS metric (ml, g, cm). This is a display
    # preference only -- the API never converts.
    units = models.CharField(
        max_length=8,
        choices=[(METRIC, "Metric (ml, g, cm)"), (IMPERIAL, "Imperial (oz, lb, in)")],
        default=METRIC,
    )
    timezone = models.CharField(max_length=64, default="America/New_York")
    members = models.ManyToManyField(settings.AUTH_USER_MODEL, through="Membership")
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name


class Membership(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    household = models.ForeignKey(Household, on_delete=models.CASCADE)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "household"], name="uniq_membership")
        ]


class Baby(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    household = models.ForeignKey(Household, on_delete=models.CASCADE, related_name="babies")
    name = models.CharField(max_length=100)
    dob = models.DateField(null=True, blank=True)
    color = models.CharField(max_length=7, default="#E8877D")
    archived = models.BooleanField(default=False)

    class Meta:
        verbose_name_plural = "babies"
        ordering = ["name"]

    def __str__(self):
        return self.name


class EventQuerySet(models.QuerySet):
    def live(self):
        return self.filter(deleted_at__isnull=True)

    def active(self):
        return self.live().filter(in_progress=True)

    def for_user(self, user):
        return self.filter(household__membership__user=user)


class Event(models.Model):
    """One table for every event type. Type-specific fields live in `payload`,
    validated per type by the serializer. See PLAN.md "Data model"."""

    FEED, DIAPER, PUMP, SLEEP = "feed", "diaper", "pump", "sleep"
    GROWTH, MED, MILESTONE, NOTE = "growth", "med", "milestone", "note"
    TYPES = [FEED, DIAPER, PUMP, SLEEP, GROWTH, MED, MILESTONE, NOTE]

    # Client-generated, so an event created offline already has its real id.
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    household = models.ForeignKey(Household, on_delete=models.CASCADE, related_name="events")
    # Null for parent events (pump), which have no baby as their subject.
    baby = models.ForeignKey(
        Baby, on_delete=models.CASCADE, related_name="events", null=True, blank=True
    )
    type = models.CharField(max_length=16, choices=[(t, t) for t in TYPES])
    started_at = models.DateTimeField()
    # The zone this was RECORDED in, so daily rollups survive travel.
    tz = models.CharField(max_length=64, default="America/New_York")
    ended_at = models.DateTimeField(null=True, blank=True)
    payload = models.JSONField(default=dict, blank=True)
    notes = models.TextField(blank=True, default="")

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)  # last-write-wins key
    deleted_at = models.DateTimeField(null=True, blank=True)  # soft delete, so sync sees it
    # A running timer, shared across the household's devices. Not derivable from
    # `ended_at is None` -- instant events (diaper, bottle, pump) have no end
    # either, and a paused timer is still in progress.
    in_progress = models.BooleanField(default=False)

    objects = EventQuerySet.as_manager()

    class Meta:
        ordering = ["-started_at"]
        indexes = [
            models.Index(fields=["household", "-started_at"]),
            models.Index(fields=["baby", "type", "-started_at"]),
            models.Index(fields=["household", "in_progress"]),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(ended_at__isnull=True)
                | models.Q(ended_at__gte=models.F("started_at")),
                name="event_ends_after_it_starts",
            ),
            models.CheckConstraint(
                condition=models.Q(in_progress=False) | models.Q(ended_at__isnull=True),
                name="in_progress_events_have_no_end",
            ),
        ]

    def __str__(self):
        return f"{self.type} @ {self.started_at:%Y-%m-%d %H:%M}"

    @property
    def duration_sec(self):
        if not self.ended_at:
            return None
        return (self.ended_at - self.started_at).total_seconds()
