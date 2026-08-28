from datetime import timedelta
from pathlib import Path

from django.contrib.auth.models import User
from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import Baby, Event, Household, Membership

# Synthetic fixture, not real data. See events/testdata/README.md.
CSV = Path(__file__).resolve().parent / "testdata" / "huckleberry-sample.csv"


def make_household(username="theo"):
    user = User.objects.create_user(username, password="pw-for-tests-only")
    hh = Household.objects.create(name="Ferguson")
    Membership.objects.create(user=user, household=hh)
    baby = Baby.objects.create(household=hh, name="Henry")
    return user, hh, baby


class ImportCommandTests(TestCase):
    def test_imports_and_is_idempotent(self):
        _, hh, baby = make_household()
        call_command("import_huckleberry", str(CSV), household=hh.pk, baby=str(baby.pk),
                     verbosity=0)
        self.assertEqual(Event.objects.count(), 13)
        # Re-running must update in place, not duplicate.
        call_command("import_huckleberry", str(CSV), household=hh.pk, baby=str(baby.pk),
                     verbosity=0)
        self.assertEqual(Event.objects.count(), 13)

        self.assertEqual(Event.objects.filter(type="pump", baby__isnull=True).count(), 3)
        self.assertEqual(Event.objects.filter(type="feed", baby=baby).count(), 4)
        # Volumes are stored metric.
        pumped = sum((e.payload.get("left_ml") or 0) + (e.payload.get("right_ml") or 0)
                     for e in Event.objects.filter(type="pump"))
        self.assertAlmostEqual(pumped / 29.5735295625, 7.25, places=2)


class EventApiTests(APITestCase):
    def setUp(self):
        self.user, self.hh, self.baby = make_household()
        self.client.force_authenticate(self.user)
        self.now = timezone.now()

    def post(self, **kw):
        body = {"baby": str(self.baby.pk), "type": "diaper",
                "started_at": self.now.isoformat(), "payload": {"pee": "small"}}
        body.update(kw)
        return self.client.post("/api/events/", body, format="json")

    def test_creates_and_lists(self):
        self.assertEqual(self.post().status_code, 201)
        r = self.client.get("/api/events/")
        self.assertEqual(r.json()["count"], 1)

    def test_rejects_unknown_payload_field(self):
        r = self.post(payload={"pee": "small", "colour": "yellow"})  # British spelling
        self.assertEqual(r.status_code, 400)
        self.assertIn("colour", str(r.json()))

    def test_rejects_bad_enum_and_empty_diaper(self):
        self.assertEqual(self.post(payload={"pee": "enormous"}).status_code, 400)
        self.assertEqual(self.post(payload={}).status_code, 400)

    def test_rejects_end_before_start(self):
        r = self.post(type="sleep", payload={},
                      ended_at=(self.now - timedelta(hours=1)).isoformat())
        self.assertEqual(r.status_code, 400)

    def test_pump_needs_no_baby_but_feed_does(self):
        self.assertEqual(self.post(type="pump", baby=None,
                                   payload={"left_ml": 60.0}).status_code, 201)
        r = self.post(type="feed", baby=None, payload={"method": "breast"})
        self.assertEqual(r.status_code, 400)

    def test_delete_is_soft_and_hidden_from_list(self):
        ev_id = self.post().json()["id"]
        self.assertEqual(self.client.delete(f"/api/events/{ev_id}/").status_code, 204)
        self.assertEqual(self.client.get("/api/events/").json()["count"], 0)
        self.assertIsNotNone(Event.objects.get(pk=ev_id).deleted_at)

    def test_another_household_cannot_see_or_use_mine(self):
        other, other_hh, other_baby = make_household("someone-else")
        self.post()
        self.client.force_authenticate(other)
        self.assertEqual(self.client.get("/api/events/").json()["count"], 0)
        # ...and cannot attach an event to my baby
        r = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "diaper",
            "started_at": self.now.isoformat(), "payload": {"pee": "small"}}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_requires_auth(self):
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get("/api/events/").status_code, 401)

    def test_latest_powers_home_screen(self):
        self.post()
        self.post(type="pump", baby=None, payload={"left_ml": 60.0})
        body = self.client.get("/api/events/latest/").json()
        self.assertEqual(set(body), {"diaper", "pump"})


class ImportReviewApiTests(APITestCase):
    def setUp(self):
        self.user, self.hh, self.baby = make_household()
        self.client.force_authenticate(self.user)

    def preview(self):
        with open(CSV, "rb") as fh:
            return self.client.post("/api/import/preview/", {"file": fh}, format="multipart")

    def test_preview_saves_nothing(self):
        r = self.preview()
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["count"], 13)
        self.assertEqual(body["counts"], {"feed": 4, "diaper": 6, "pump": 3})
        self.assertEqual(Event.objects.count(), 0)  # nothing committed yet
        self.assertFalse(body["events"][0]["already_imported"])

    def test_commit_accepts_edited_rows(self):
        events = self.preview().json()["events"]
        events[0]["notes"] = "edited in review"
        r = self.client.post("/api/import/commit/",
                             {"baby": str(self.baby.pk), "events": events}, format="json")
        self.assertEqual(r.status_code, 201)
        self.assertEqual(Event.objects.count(), 13)
        self.assertEqual(Event.objects.get(pk=events[0]["id"]).notes, "edited in review")

        # Second preview knows what is already in.
        self.assertEqual(self.preview().json()["already_imported"], 13)

    def test_preview_flags_bad_rows_without_blocking(self):
        body = self.preview().json()
        self.assertEqual(body["invalid"], 0)
        self.assertTrue(all(r["errors"] == [] for r in body["events"]))

    def test_commit_skips_bad_rows_and_saves_the_rest(self):
        events = self.preview().json()["events"]
        events[5] = {**events[5], "type": "diaper", "payload": {"pee": "enormous"}}
        r = self.client.post("/api/import/commit/",
                             {"baby": str(self.baby.pk), "events": events}, format="json")
        self.assertEqual(r.status_code, 201)
        body = r.json()
        self.assertEqual(body["saved"], 12)
        self.assertEqual(body["skipped"][0]["index"], 5)
        self.assertEqual(Event.objects.count(), 12)
        # The skipped row can be fixed and re-sent on its own.
        fixed = {**events[5], "payload": {"pee": "small"}}
        r2 = self.client.post("/api/import/commit/",
                              {"baby": str(self.baby.pk), "events": [fixed]}, format="json")
        self.assertEqual(r2.json()["saved"], 1)
        self.assertEqual(Event.objects.count(), 13)

    def test_commit_only_saves_the_selected_rows(self):
        events = self.preview().json()["events"]
        selected = events[:5]  # user unchecked the rest
        r = self.client.post("/api/import/commit/",
                             {"baby": str(self.baby.pk), "events": selected}, format="json")
        self.assertEqual(r.json()["saved"], 5)
        self.assertEqual(Event.objects.count(), 5)
        # Re-previewing shows exactly which ones already landed.
        self.assertEqual(self.preview().json()["already_imported"], 5)

    def test_commit_fails_when_nothing_valid_survives(self):
        events = [{**e, "payload": {"pee": "enormous"}, "type": "diaper"}
                  for e in self.preview().json()["events"][:3]]
        r = self.client.post("/api/import/commit/",
                             {"baby": str(self.baby.pk), "events": events}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["saved"], 0)
        self.assertEqual(Event.objects.count(), 0)

    def test_commit_without_baby_skips_baby_rows_but_keeps_pumps(self):
        events = self.preview().json()["events"]
        r = self.client.post("/api/import/commit/", {"events": events}, format="json")
        self.assertEqual(r.json()["saved"], 3)  # the pumps, which need no baby
        self.assertEqual(len(r.json()["skipped"]), 10)
        self.assertEqual(Event.objects.filter(type="pump").count(), 3)

    def test_preview_rejects_junk(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        junk = SimpleUploadedFile("x.csv", b"Type,Start\nSpaceship,2026-01-01 00:00\n")
        r = self.client.post("/api/import/preview/", {"file": junk}, format="multipart")
        self.assertEqual(r.status_code, 400)
