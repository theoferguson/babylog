from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from events.importers.huckleberry import parse
from events.models import Baby, Event, Household


class Command(BaseCommand):
    help = "Import a Huckleberry CSV export. Idempotent -- re-running updates in place."

    def add_arguments(self, p):
        p.add_argument("csv")
        p.add_argument("--household", required=True, help="household id")
        p.add_argument("--baby", required=True, help="baby id (pump rows get none)")
        p.add_argument("--tz", default=None, help="zone the export was recorded in")
        p.add_argument("--dry-run", action="store_true")

    def handle(self, *a, **o):
        try:
            household = Household.objects.get(pk=o["household"])
            baby = Baby.objects.get(pk=o["baby"], household=household)
        except (Household.DoesNotExist, Baby.DoesNotExist) as e:
            raise CommandError(str(e))

        rows = parse(o["csv"], tz=o["tz"] or household.timezone)
        events = [
            Event(id=r["id"], household=household,
                  baby=None if r["type"] == Event.PUMP else baby,
                  type=r["type"], started_at=r["started_at"], ended_at=r["ended_at"],
                  tz=r["tz"], payload=r["payload"], notes=r["notes"])
            for r in rows
        ]
        counts = {}
        for r in rows:
            counts[r["type"]] = counts.get(r["type"], 0) + 1
        self.stdout.write(f"parsed {len(rows)}: " +
                          ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
        if o["dry_run"]:
            self.stdout.write(self.style.WARNING("dry run -- nothing saved"))
            return
        with transaction.atomic():
            Event.objects.bulk_create(
                events, update_conflicts=True, unique_fields=["id"],
                update_fields=["baby", "type", "started_at", "ended_at", "tz",
                               "payload", "notes"])
        self.stdout.write(self.style.SUCCESS(f"saved {len(events)}"))
