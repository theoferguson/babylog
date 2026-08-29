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


class SharedTimerTests(APITestCase):
    """A running timer belongs to the household, not to the phone that started it."""

    def setUp(self):
        self.theo, self.hh, self.baby = make_household("theo-timer")
        self.partner = User.objects.create_user("partner", password="pw-for-tests-only")
        Membership.objects.create(user=self.partner, household=self.hh)
        self.t0 = timezone.now() - timedelta(minutes=30)
        self.client.force_authenticate(self.theo)

    def start_feed(self):
        r = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": self.t0.isoformat(), "in_progress": True,
            "payload": {"method": "breast"}}, format="json")
        self.assertEqual(r.status_code, 201, r.json())
        return r.json()["id"]

    def tick(self, ev_id, action, side=None, at=None):
        body = {"action": action}
        if side:
            body["side"] = side
        if at:
            body["at"] = at.isoformat()
        return self.client.post(f"/api/events/{ev_id}/timer/", body, format="json")

    def test_partner_sees_and_stops_the_timer_theo_started(self):
        ev_id = self.start_feed()
        self.tick(ev_id, "start", "R", self.t0)

        # Partner's phone polls and finds it running.
        self.client.force_authenticate(self.partner)
        active = self.client.get("/api/events/active/").json()
        self.assertEqual(len(active["events"]), 1)
        self.assertEqual(active["events"][0]["payload"]["running_side"], "R")

        # ...and stops it 13 minutes in, from their device.
        r = self.tick(ev_id, "stop", at=self.t0 + timedelta(minutes=13))
        self.assertEqual(r.json()["payload"]["right_sec"], 13 * 60)
        self.assertNotIn("running_side", r.json()["payload"])

    def test_sides_accumulate_across_switches(self):
        ev_id = self.start_feed()
        self.tick(ev_id, "start", "R", self.t0)
        # Switching sides banks the running one and starts the other.
        self.tick(ev_id, "start", "L", self.t0 + timedelta(minutes=13))
        self.tick(ev_id, "start", "R", self.t0 + timedelta(minutes=21))  # back to R
        r = self.tick(ev_id, "stop", at=self.t0 + timedelta(minutes=25))
        p = r.json()["payload"]
        self.assertEqual(p["right_sec"], (13 + 4) * 60)  # R ran twice
        self.assertEqual(p["left_sec"], 8 * 60)
        self.assertEqual(p["last_side"], "R")

    def test_finish_sets_end_and_leaves_active(self):
        ev_id = self.start_feed()
        self.tick(ev_id, "start", "L", self.t0)
        end = self.t0 + timedelta(minutes=20)
        r = self.client.post(f"/api/events/{ev_id}/finish/",
                             {"at": end.isoformat()}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["payload"]["left_sec"], 20 * 60)
        self.assertFalse(r.json()["in_progress"])
        self.assertEqual(self.client.get("/api/events/active/").json()["events"], [])
        # ...and a finished timer cannot be ticked again.
        self.assertEqual(self.tick(ev_id, "start", "R").status_code, 400)

    def test_editing_while_running_does_not_disturb_the_clock(self):
        ev_id = self.start_feed()
        self.tick(ev_id, "start", "R", self.t0)
        r = self.client.patch(f"/api/events/{ev_id}/", {"notes": "fussy"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["payload"]["running_side"], "R")

    def test_rejects_future_and_naive_timestamps(self):
        ev_id = self.start_feed()
        future = (timezone.now() + timedelta(hours=2)).isoformat()
        self.assertEqual(self.tick(ev_id, "start", "R",
                                   timezone.now() + timedelta(hours=2)).status_code, 400)
        r = self.client.post(f"/api/events/{ev_id}/timer/",
                             {"action": "start", "side": "R",
                              "at": "2026-08-28T10:00:00"}, format="json")
        self.assertEqual(r.status_code, 400)  # naive, no offset
        self.assertIn("timezone", str(r.json()).lower())

    def test_backwards_clock_never_subtracts_banked_time(self):
        ev_id = self.start_feed()
        self.tick(ev_id, "start", "R", self.t0)
        # A device whose clock has drifted backwards reports an earlier stop.
        r = self.tick(ev_id, "stop", at=self.t0 - timedelta(minutes=5))
        self.assertEqual(r.json()["payload"].get("right_sec"), 0)

    def test_another_household_cannot_touch_the_timer(self):
        ev_id = self.start_feed()
        outsider, _, _ = make_household("outsider")
        self.client.force_authenticate(outsider)
        self.assertEqual(self.client.get("/api/events/active/").json()["events"], [])
        self.assertEqual(self.tick(ev_id, "stop").status_code, 404)

    def test_in_progress_event_cannot_carry_an_end(self):
        r = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": self.t0.isoformat(),
            "ended_at": timezone.now().isoformat(),
            "in_progress": True, "payload": {"method": "breast"}}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_discarding_a_timer_removes_it_from_active(self):
        ev_id = self.start_feed()
        self.tick(ev_id, "start", "R", self.t0)
        self.assertEqual(self.client.delete(f"/api/events/{ev_id}/").status_code, 204)
        self.assertEqual(self.client.get("/api/events/active/").json()["events"], [])


class CorsTests(APITestCase):
    """The web build is a different origin from the API; native builds are not."""

    def test_allowed_origin_gets_a_cors_header(self):
        r = self.client.options("/api/auth/token/", HTTP_ORIGIN="http://localhost:8081",
                                HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST")
        self.assertEqual(r.headers.get("Access-Control-Allow-Origin"), "http://localhost:8081")

    def test_unknown_origin_gets_nothing(self):
        # Never reflect arbitrary origins: the API is token-authenticated, and a
        # permissive header would let any page a browser visits read this data.
        r = self.client.options("/api/auth/token/", HTTP_ORIGIN="https://evil.example",
                                HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST")
        self.assertIsNone(r.headers.get("Access-Control-Allow-Origin"))


class EventDetailTests(APITestCase):
    """The edit screen loads one event, patches it, and soft-deletes it."""

    def setUp(self):
        self.user, self.hh, self.baby = make_household("theo-detail")
        self.client.force_authenticate(self.user)
        r = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "diaper",
            "started_at": timezone.now().isoformat(),
            "payload": {"pee": "small"}}, format="json")
        self.ev = r.json()["id"]

    def test_retrieve_then_patch_payload_and_time(self):
        r = self.client.get(f"/api/events/{self.ev}/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["payload"], {"pee": "small"})

        earlier = (timezone.now() - timedelta(hours=3)).isoformat()
        r = self.client.patch(f"/api/events/{self.ev}/", {
            "payload": {"pee": "large", "poo": "medium"},
            "started_at": earlier, "notes": "changed"}, format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.assertEqual(r.json()["payload"]["poo"], "medium")
        self.assertEqual(r.json()["notes"], "changed")

    def test_patch_still_validates_the_payload(self):
        r = self.client.patch(f"/api/events/{self.ev}/",
                              {"payload": {"pee": "enormous"}}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_deleted_event_is_not_retrievable(self):
        self.client.delete(f"/api/events/{self.ev}/")
        self.assertEqual(self.client.get(f"/api/events/{self.ev}/").status_code, 404)

    def test_another_household_cannot_retrieve_it(self):
        other, _, _ = make_household("detail-outsider")
        self.client.force_authenticate(other)
        self.assertEqual(self.client.get(f"/api/events/{self.ev}/").status_code, 404)
