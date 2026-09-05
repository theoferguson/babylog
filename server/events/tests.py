import tempfile
import uuid
from datetime import timedelta
from unittest import mock
from pathlib import Path

from django.contrib.auth.models import User
from django.core import mail
from django.core.cache import cache
from django.core.management import call_command
from django.test import Client, TestCase
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.test import APITestCase

from .models import Baby, Event, Household, Invite, Membership
from .parsing import SPOKEN_FIELDS, schema
from .serializers import PAYLOAD_FIELDS

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


class WebBuildTests(TestCase):
    """The catch-all serves the Expo build without exposing the filesystem."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.tmp = Path(tempfile.mkdtemp())
        (cls.tmp / "log").mkdir()
        (cls.tmp / "index.html").write_text("<html>spa</html>")
        (cls.tmp / "nurse.html").write_text("<html>nurse</html>")
        (cls.tmp / "log" / "bottle.html").write_text("<html>bottle</html>")
        (cls.tmp.parent / "secret.txt").write_text("do not serve me")

    def body(self, resp):
        return b"".join(resp.streaming_content).decode()

    def test_root_serves_the_spa_entry(self):
        with self.settings(WEB_ROOT=self.tmp):
            r = self.client.get("/")
            self.assertEqual(r.status_code, 200)
            self.assertIn("spa", self.body(r))

    def test_pretty_routes_map_to_flat_html(self):
        with self.settings(WEB_ROOT=self.tmp):
            self.assertIn("nurse", self.body(self.client.get("/nurse")))
            self.assertIn("bottle", self.body(self.client.get("/log/bottle")))

    def test_unknown_route_falls_back_to_the_spa(self):
        # A dynamic route like /event/<uuid> has no file; expo-router resolves it
        # client-side after the entry loads.
        with self.settings(WEB_ROOT=self.tmp):
            r = self.client.get("/event/2f1c9b1e-0000-4000-8000-000000000000")
            self.assertEqual(r.status_code, 200)
            self.assertIn("spa", self.body(r))

    def test_traversal_cannot_escape_the_build_directory(self):
        with self.settings(WEB_ROOT=self.tmp):
            r = self.client.get("/../secret")
            # Either refused outright or handed the SPA entry -- never the file.
            if r.status_code == 200:
                self.assertNotIn("do not serve me", self.body(r))

    def test_api_routes_are_not_swallowed_by_the_catch_all(self):
        with self.settings(WEB_ROOT=self.tmp):
            self.assertEqual(self.client.get("/api/events/").status_code, 401)
            self.assertEqual(self.client.get("/healthz").status_code, 200)

    def test_missing_build_does_not_500(self):
        with self.settings(WEB_ROOT=Path("/nonexistent")):
            self.assertEqual(self.client.get("/").status_code, 404)


class OfflineNursingTests(APITestCase):
    """Two offline shapes: replayed timer intents, and a whole feed created after."""

    def setUp(self):
        self.user, self.hh, self.baby = make_household("theo-offline")
        self.client.force_authenticate(self.user)
        self.t0 = timezone.now() - timedelta(minutes=40)

    def test_intents_queued_offline_replay_to_the_same_totals(self):
        r = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": self.t0.isoformat(), "in_progress": True,
            "payload": {"method": "breast"}}, format="json")
        ev = r.json()["id"]

        # The phone went offline after the first tap. These three all flush later,
        # in order, carrying the times the buttons were actually pressed.
        for body in [
            {"action": "start", "side": "R", "at": self.t0.isoformat()},
            {"action": "start", "side": "L",
             "at": (self.t0 + timedelta(minutes=13)).isoformat()},
            {"action": "stop", "at": (self.t0 + timedelta(minutes=21)).isoformat()},
        ]:
            self.assertEqual(
                self.client.post(f"/api/events/{ev}/timer/", body, format="json").status_code,
                200,
            )
        p = self.client.get(f"/api/events/{ev}/").json()["payload"]
        # Identical to what an online session would have produced.
        self.assertEqual(p["right_sec"], 13 * 60)
        self.assertEqual(p["left_sec"], 8 * 60)

    def test_queued_finish_uses_the_tap_time_not_the_flush_time(self):
        r = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": self.t0.isoformat(), "in_progress": True,
            "payload": {"method": "breast"}}, format="json")
        ev = r.json()["id"]
        self.client.post(f"/api/events/{ev}/timer/",
                         {"action": "start", "side": "L", "at": self.t0.isoformat()},
                         format="json")
        end = self.t0 + timedelta(minutes=18)
        r = self.client.post(f"/api/events/{ev}/finish/", {"at": end.isoformat()},
                             format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["payload"]["left_sec"], 18 * 60)
        # 18 minutes, not the 40 that have elapsed since the feed began.
        self.assertEqual(r.json()["duration_sec"], 18 * 60)

    def test_a_whole_feed_created_offline_is_accepted(self):
        # No event ever reached the server; the app queues the finished feed.
        body = {
            "id": "9f2b1c44-1111-4000-8000-000000000001",
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": self.t0.isoformat(),
            "ended_at": (self.t0 + timedelta(minutes=25)).isoformat(),
            "tz": "America/New_York", "in_progress": False, "notes": "logged offline",
            "payload": {"method": "breast", "right_sec": 1020, "left_sec": 480,
                        "last_side": "R"},
        }
        r = self.client.post("/api/events/", body, format="json")
        self.assertEqual(r.status_code, 201, r.json())
        self.assertEqual(r.json()["duration_sec"], 25 * 60)
        self.assertFalse(r.json()["in_progress"])
        self.assertEqual(self.client.get("/api/events/active/").json()["events"], [])

        # The client chose the id, so flushing the same queued write twice
        # upserts instead of creating a second feed.
        self.assertEqual(r.json()["id"], body["id"])
        again = self.client.post("/api/events/", body, format="json")
        self.assertEqual(again.status_code, 200)
        self.assertEqual(Event.objects.filter(type="feed").count(), 1)

    def test_a_replayed_create_cannot_hijack_another_household(self):
        other, other_hh, other_baby = make_household("offline-outsider")
        r = self.client.post("/api/events/", {
            "id": "9f2b1c44-1111-4000-8000-000000000002",
            "baby": str(self.baby.pk), "type": "diaper",
            "started_at": self.t0.isoformat(), "payload": {"pee": "small"}}, format="json")
        self.assertEqual(r.status_code, 201)
        self.client.force_authenticate(other)
        r2 = self.client.post("/api/events/", {
            "id": "9f2b1c44-1111-4000-8000-000000000002",
            "baby": str(other_baby.pk), "type": "diaper",
            "started_at": self.t0.isoformat(), "payload": {"pee": "large"}}, format="json")
        self.assertEqual(r2.status_code, 400)
        self.assertEqual(Event.objects.get(pk="9f2b1c44-1111-4000-8000-000000000002")
                         .payload["pee"], "small")

    def test_a_replayed_create_does_not_resurrect_a_deleted_event(self):
        body = {
            "id": "9f2b1c44-1111-4000-8000-000000000003",
            "baby": str(self.baby.pk), "type": "diaper",
            "started_at": self.t0.isoformat(), "payload": {"pee": "small"},
        }
        self.client.post("/api/events/", body, format="json")
        self.client.delete(f"/api/events/{body['id']}/")
        again = self.client.post("/api/events/", body, format="json")
        self.assertEqual(again.status_code, 200)
        self.assertIsNotNone(Event.objects.get(pk=body["id"]).deleted_at)
        self.assertEqual(self.client.get("/api/events/").json()["count"], 0)


class IdempotencyEdgeTests(APITestCase):
    """Replayed and malformed writes must not corrupt data or 500."""

    def setUp(self):
        self.user, self.hh, self.baby = make_household("theo-idem")
        self.client.force_authenticate(self.user)
        self.now = timezone.now()

    def make(self, ev_id, **kw):
        body = {"id": ev_id, "baby": str(self.baby.pk), "type": "diaper",
                "started_at": self.now.isoformat(), "payload": {"pee": "small"}}
        body.update(kw)
        return self.client.post("/api/events/", body, format="json")

    def test_id_cannot_be_changed_by_update(self):
        a = "11111111-1111-4000-8000-000000000001"
        b = "22222222-2222-4000-8000-000000000002"
        self.make(a)
        r = self.client.patch(f"/api/events/{a}/", {"id": b, "payload": {"pee": "large"}},
                              format="json")
        self.assertEqual(r.status_code, 200)
        # A changed pk would UPDATE nothing and then INSERT a copy.
        self.assertEqual(Event.objects.count(), 1)
        self.assertEqual(Event.objects.get().payload["pee"], "large")
        self.assertFalse(Event.objects.filter(pk=b).exists())

    def test_malformed_id_is_a_400_not_a_500(self):
        r = self.make("not-a-uuid")
        self.assertEqual(r.status_code, 400)
        self.assertIn("id", r.json())

    def test_replayed_start_after_finish_is_a_no_op(self):
        ev = "33333333-3333-4000-8000-000000000003"
        self.make(ev, type="feed", in_progress=True, payload={"method": "breast"})
        self.client.post(f"/api/events/{ev}/finish/", {}, format="json")
        # The queued bootstrap write flushes late; it must not revive the timer.
        again = self.make(ev, type="feed", in_progress=True, payload={"method": "breast"})
        self.assertEqual(again.status_code, 200)
        self.assertFalse(again.json()["in_progress"])
        self.assertIsNotNone(Event.objects.get(pk=ev).ended_at)
        self.assertEqual(self.client.get("/api/events/active/").json()["events"], [])


class BabyLifecycleTests(APITestCase):
    def setUp(self):
        self.user, self.hh, self.baby = make_household("theo-baby")
        self.client.force_authenticate(self.user)

    def test_can_add_and_edit_a_baby(self):
        r = self.client.post("/api/babies/", {"name": "Second", "dob": "2026-08-01",
                                              "color": "#9CB981"}, format="json")
        self.assertEqual(r.status_code, 201, r.json())
        bid = r.json()["id"]
        r = self.client.patch(f"/api/babies/{bid}/", {"name": "Renamed"}, format="json")
        self.assertEqual(r.json()["name"], "Renamed")

    def test_archiving_keeps_the_events(self):
        self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "diaper",
            "started_at": timezone.now().isoformat(),
            "payload": {"pee": "small"}}, format="json")
        r = self.client.patch(f"/api/babies/{self.baby.pk}/", {"archived": True},
                              format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(Event.objects.count(), 1)

    def test_deleting_a_baby_with_history_is_refused(self):
        self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "diaper",
            "started_at": timezone.now().isoformat(),
            "payload": {"pee": "small"}}, format="json")
        r = self.client.delete(f"/api/babies/{self.baby.pk}/")
        self.assertEqual(r.status_code, 400)
        self.assertIn("archive", str(r.json()).lower())
        self.assertEqual(Event.objects.count(), 1)  # history intact

    def test_a_baby_with_no_history_can_be_deleted(self):
        r = self.client.post("/api/babies/", {"name": "Mistake"}, format="json")
        self.assertEqual(self.client.delete(f"/api/babies/{r.json()['id']}/").status_code, 204)

    def test_household_settings_can_be_changed(self):
        r = self.client.patch(f"/api/households/{self.hh.pk}/",
                              {"units": "imperial", "timezone": "Europe/Lisbon",
                               "name": "Ferguson"}, format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.assertEqual(r.json()["units"], "imperial")
        self.assertEqual(r.json()["timezone"], "Europe/Lisbon")

    def test_cannot_touch_another_households_baby(self):
        other, _, _ = make_household("baby-outsider")
        self.client.force_authenticate(other)
        self.assertEqual(
            self.client.patch(f"/api/babies/{self.baby.pk}/", {"name": "x"},
                              format="json").status_code, 404)


class InviteTests(APITestCase):
    """Registration is the only unauthenticated write in the API, so it gets the
    most scrutiny here."""

    def setUp(self):
        self.user, self.hh, self.baby = make_household("theo-invite")
        self.client.force_authenticate(self.user)
        mail.outbox = []
        # DRF throttling is cache-backed and the cache outlives a single test,
        # so without this the later tests here get 429s from earlier ones.
        cache.clear()

    def make_invite(self, email="partner@example.com"):
        r = self.client.post("/api/invites/", {"email": email}, format="json")
        self.assertEqual(r.status_code, 201, r.json())
        return r.json()

    def code_of(self, body):
        return body["link"].split("code=")[1]

    def register(self, **kw):
        self.client.force_authenticate(None)
        body = {"username": "partner", "password": "a-good-long-passphrase-42"}
        body.update(kw)
        return self.client.post("/api/auth/register/", body, format="json")

    def test_inviting_sends_a_link_to_that_address(self):
        body = self.make_invite("wife@example.com")
        self.assertTrue(body["email_sent"])
        self.assertEqual(len(mail.outbox), 1)
        msg = mail.outbox[0]
        self.assertEqual(msg.to, ["wife@example.com"])
        self.assertIn(self.code_of(body), msg.body)
        self.assertIn("/join?code=", msg.body)
        # The raw code is never returned on its own, only inside the link.
        self.assertNotIn("code", set(body) - {"link"})

    def test_email_is_required_and_validated(self):
        self.assertEqual(self.client.post("/api/invites/", {}, format="json").status_code, 400)
        r = self.client.post("/api/invites/", {"email": "not-an-email"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(Invite.objects.count(), 0)

    def test_invited_user_joins_the_same_household_and_sees_its_events(self):
        self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "diaper",
            "started_at": timezone.now().isoformat(),
            "payload": {"pee": "small"}}, format="json")
        code = self.code_of(self.make_invite())

        r = self.register(code=code)
        self.assertEqual(r.status_code, 201, r.json())
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {r.json()['token']}")
        self.assertEqual(self.client.get("/api/events/").json()["count"], 1)
        self.assertEqual(self.client.get("/api/babies/").json()["results"][0]["name"], "Henry")

    def test_a_link_can_only_ever_create_one_account(self):
        code = self.code_of(self.make_invite())
        self.assertEqual(self.register(code=code).status_code, 201)
        for name in ("third", "fourth"):
            r = self.register(code=code, username=name)
            self.assertEqual(r.status_code, 400)
            self.assertFalse(User.objects.filter(username=name).exists())
        self.assertEqual(Membership.objects.filter(household=self.hh).count(), 2)

    def test_a_used_invite_cannot_be_resent(self):
        body = self.make_invite()
        self.assertEqual(self.register(code=self.code_of(body)).status_code, 201)
        self.client.force_authenticate(self.user)
        r = self.client.post(f"/api/invites/{body['id']}/resend/", {}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_resending_an_open_invite_sends_it_again(self):
        body = self.make_invite()
        mail.outbox = []
        r = self.client.post(f"/api/invites/{body['id']}/resend/", {}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn(self.code_of(body), mail.outbox[0].body)

    def test_expired_and_unknown_codes_are_indistinguishable(self):
        stale = Invite.objects.create(household=self.hh, created_by=self.user,
                                      email="stale@example.com")
        stale.expires_at = timezone.now() - timedelta(minutes=1)
        stale.save()
        expired = self.register(code=stale.code)
        unknown = self.register(code="totally-made-up", username="other")
        self.assertEqual(expired.status_code, 400)
        self.assertEqual(unknown.status_code, 400)
        # Same wording, so probing cannot tell a real code from a fake one.
        self.assertEqual(str(expired.json()), str(unknown.json()))

    def test_weak_passwords_and_taken_usernames_are_rejected(self):
        code = self.code_of(self.make_invite())
        self.assertEqual(self.register(code=code, password="12345678").status_code, 400)
        self.assertEqual(self.register(code=code, username="THEO-INVITE").status_code, 400,
                         "username collision must be case-insensitive")
        # ...and neither consumed the invite.
        self.assertEqual(self.register(code=code).status_code, 201)

    def test_repeated_attempts_are_throttled_but_not_instantly(self):
        # A parent fumbling a password a few times must not be locked out, while
        # someone grinding codes should be.
        code = self.code_of(self.make_invite())
        codes = [self.register(code="wrong", username=f"u{i}").status_code for i in range(6)]
        self.assertNotIn(429, codes, "six bad attempts is normal human behaviour")
        self.assertEqual(self.register(code=code).status_code, 201)

    def test_registering_without_a_code_is_refused(self):
        r = self.register()
        self.assertEqual(r.status_code, 400)
        self.assertEqual(User.objects.filter(username="partner").count(), 0)

    def test_invites_are_scoped_to_the_household(self):
        body = self.make_invite()
        other, _, _ = make_household("invite-outsider")
        self.client.force_authenticate(other)
        self.assertEqual(self.client.get("/api/invites/").json()["count"], 0)
        self.assertEqual(self.client.delete(f"/api/invites/{body['id']}/").status_code, 404)
        self.assertEqual(
            self.client.post(f"/api/invites/{body['id']}/resend/", {}, format="json").status_code,
            404)

    def test_an_invite_can_be_revoked_before_use(self):
        body = self.make_invite()
        self.assertEqual(self.client.delete(f"/api/invites/{body['id']}/").status_code, 204)
        self.assertEqual(self.register(code=self.code_of(body)).status_code, 400)


class RunningFeedEditTests(APITestCase):
    """A feed can be corrected while it is still running or paused."""

    def setUp(self):
        self.user, self.hh, self.baby = make_household("theo-running")
        self.client.force_authenticate(self.user)
        self.t0 = timezone.now() - timedelta(minutes=30)
        r = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": self.t0.isoformat(), "in_progress": True,
            "payload": {"method": "breast"}}, format="json")
        self.ev = r.json()["id"]

    def tick(self, action, side=None, at=None):
        body = {"action": action}
        if side:
            body["side"] = side
        if at:
            body["at"] = at.isoformat()
        return self.client.post(f"/api/events/{self.ev}/timer/", body, format="json")

    def test_start_time_can_be_moved_while_running(self):
        self.tick("start", "R", self.t0)
        earlier = (self.t0 - timedelta(minutes=10)).isoformat()
        r = self.client.patch(f"/api/events/{self.ev}/", {"started_at": earlier},
                              format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.assertTrue(r.json()["in_progress"])
        # The clock keeps running: the side is untouched by the correction.
        self.assertEqual(r.json()["payload"]["running_side"], "R")

    def test_start_time_can_be_moved_while_paused(self):
        self.tick("start", "L", self.t0)
        self.tick("stop", at=self.t0 + timedelta(minutes=12))
        earlier = (self.t0 - timedelta(minutes=5)).isoformat()
        r = self.client.patch(f"/api/events/{self.ev}/", {"started_at": earlier},
                              format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.assertEqual(r.json()["payload"]["left_sec"], 12 * 60)

    def test_the_start_time_can_be_moved_anywhere_in_the_past(self):
        self.tick("start", "R", self.t0)
        self.tick("stop", at=self.t0 + timedelta(minutes=25))
        # started_at only pins the feed on the calendar, so moving it cannot
        # contradict the 25 minutes already on the clock.
        r = self.client.patch(
            f"/api/events/{self.ev}/",
            {"started_at": (timezone.now() - timedelta(minutes=2)).isoformat()},
            format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.assertEqual(r.json()["payload"]["right_sec"], 25 * 60)
        self.assertEqual(r.json()["duration_sec"], 25 * 60)

    def test_start_time_cannot_be_in_the_future(self):
        soon = (timezone.now() + timedelta(hours=1)).isoformat()
        r = self.client.patch(f"/api/events/{self.ev}/", {"started_at": soon},
                              format="json")
        self.assertEqual(r.status_code, 400)

    def test_side_minutes_can_be_edited_freely(self):
        self.tick("start", "R", self.t0)
        self.client.post(f"/api/events/{self.ev}/finish/",
                         {"at": (self.t0 + timedelta(minutes=20)).isoformat()},
                         format="json")
        # The recorded end does not cap the sides: it is only when Save happened.
        r = self.client.patch(f"/api/events/{self.ev}/", {
            "payload": {"method": "breast", "right_sec": 45 * 60}}, format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.assertEqual(r.json()["duration_sec"], 45 * 60)

    def test_notes_can_be_edited_while_running(self):
        self.tick("start", "R", self.t0)
        r = self.client.patch(f"/api/events/{self.ev}/", {"notes": "fussy"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["notes"], "fussy")
        self.assertEqual(r.json()["payload"]["running_side"], "R")


class SingleRunningFeedTests(APITestCase):
    """Starting a feed while one is already running joins it, never forks it."""

    def setUp(self):
        self.user, self.hh, self.baby = make_household("theo-single")
        self.partner = User.objects.create_user("partner2", password="pw-for-tests-only")
        Membership.objects.create(user=self.partner, household=self.hh)
        self.client.force_authenticate(self.user)

    def start(self):
        return self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": timezone.now().isoformat(), "in_progress": True,
            "payload": {"method": "breast"}}, format="json")

    def test_a_second_start_returns_the_running_feed(self):
        first = self.start()
        self.assertEqual(first.status_code, 201)
        second = self.start()
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["id"], first.json()["id"])
        self.assertEqual(Event.objects.filter(type="feed").count(), 1)

    def test_the_partner_joins_the_same_timer_rather_than_starting_another(self):
        first = self.start()
        self.client.force_authenticate(self.partner)
        second = self.start()
        self.assertEqual(second.json()["id"], first.json()["id"])
        self.assertEqual(self.client.get("/api/events/active/").json()["events"].__len__(), 1)

    def test_a_new_feed_can_start_once_the_previous_one_is_finished(self):
        first = self.start()
        self.client.post(f"/api/events/{first.json()['id']}/finish/", {}, format="json")
        second = self.start()
        self.assertEqual(second.status_code, 201)
        self.assertNotEqual(second.json()["id"], first.json()["id"])

    def test_a_discarded_feed_does_not_block_the_next_one(self):
        first = self.start()
        self.client.delete(f"/api/events/{first.json()['id']}/")
        self.assertEqual(self.start().status_code, 201)

    def test_another_baby_can_nurse_at_the_same_time(self):
        twin = Baby.objects.create(household=self.hh, name="Twin")
        self.start()
        r = self.client.post("/api/events/", {
            "baby": str(twin.pk), "type": "feed",
            "started_at": timezone.now().isoformat(), "in_progress": True,
            "payload": {"method": "breast"}}, format="json")
        self.assertEqual(r.status_code, 201)
        self.assertEqual(len(self.client.get("/api/events/active/").json()["events"]), 2)


class SessionCookieDoesNotBreakTheApiTests(TestCase):
    """The web app is served from the same host as the API, so a browser that has
    logged into /admin/ sends that session cookie with every API call. It must be
    ignored rather than triggering CSRF enforcement."""

    def setUp(self):
        self.user = User.objects.create_user("theo-csrf", password="pw-for-tests-only",
                                             is_staff=True, is_superuser=True)
        hh = Household.objects.create(name="Ferguson")
        Membership.objects.create(user=self.user, household=hh)

    def test_signing_in_works_while_holding_an_admin_session(self):
        c = Client(enforce_csrf_checks=True)
        c.login(username="theo-csrf", password="pw-for-tests-only")
        self.assertIn("sessionid", c.cookies)
        r = c.post("/api/auth/token/",
                   {"username": "theo-csrf", "password": "pw-for-tests-only"},
                   content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("token", r.json())

    def test_writes_work_with_a_token_while_holding_an_admin_session(self):
        c = Client(enforce_csrf_checks=True)
        c.login(username="theo-csrf", password="pw-for-tests-only")
        token = c.post("/api/auth/token/",
                       {"username": "theo-csrf", "password": "pw-for-tests-only"},
                       content_type="application/json").json()["token"]
        baby = c.post("/api/babies/", {"name": "Henry"}, content_type="application/json",
                      HTTP_AUTHORIZATION=f"Token {token}")
        self.assertEqual(baby.status_code, 201, baby.content)

    def test_a_session_cookie_alone_does_not_authenticate(self):
        # The cookie must be inert, not a second way in.
        c = Client(enforce_csrf_checks=True)
        c.login(username="theo-csrf", password="pw-for-tests-only")
        self.assertEqual(c.get("/api/events/").status_code, 401)


class FeedStretchTests(APITestCase):
    """Editing side times should be able to lengthen the feed, not be refused."""

    def setUp(self):
        self.user, self.hh, self.baby = make_household("theo-stretch")
        self.client.force_authenticate(self.user)
        self.t0 = timezone.now() - timedelta(hours=2)
        r = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": self.t0.isoformat(),
            "ended_at": (self.t0 + timedelta(minutes=21)).isoformat(),
            "payload": {"method": "breast", "right_sec": 13 * 60, "left_sec": 8 * 60}},
            format="json")
        self.assertEqual(r.status_code, 201, r.json())
        self.ev = r.json()["id"]

    def test_growing_a_side_and_the_end_together_is_accepted(self):
        # What the editor now sends: 30 minutes of sides, with the end stretched
        # to match.
        r = self.client.patch(f"/api/events/{self.ev}/", {
            "payload": {"method": "breast", "right_sec": 18 * 60, "left_sec": 12 * 60},
            "ended_at": (self.t0 + timedelta(minutes=30)).isoformat()}, format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.assertEqual(r.json()["duration_sec"], 30 * 60)

    def test_growing_a_side_alone_is_accepted(self):
        # Nothing needs to be stretched to accommodate it any more.
        r = self.client.patch(f"/api/events/{self.ev}/", {
            "payload": {"method": "breast", "right_sec": 18 * 60, "left_sec": 12 * 60}},
            format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.assertEqual(r.json()["duration_sec"], 30 * 60)

    def test_shrinking_a_side_shortens_the_duration_but_not_the_span(self):
        # Duration is nursing time, so cutting the sides cuts it. The recorded
        # end is untouched: the feed still finished when it finished.
        r = self.client.patch(f"/api/events/{self.ev}/", {
            "payload": {"method": "breast", "right_sec": 5 * 60, "left_sec": 5 * 60}},
            format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.assertEqual(r.json()["duration_sec"], 10 * 60)
        self.assertEqual(
            parse_datetime(r.json()["ended_at"]) - parse_datetime(r.json()["started_at"]),
            timedelta(minutes=21))


class StartTimeCarriesTheRunningSideTests(APITestCase):
    """The total is time the timer ran, so correcting the start has to land in it."""

    def setUp(self):
        self.user, self.hh, self.baby = make_household("theo-carry")
        self.client.force_authenticate(self.user)
        self.t0 = timezone.now() - timedelta(minutes=13)
        r = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": self.t0.isoformat(), "in_progress": True,
            "payload": {"method": "breast"}}, format="json")
        self.ev = r.json()["id"]

    def running_since(self):
        return parse_datetime(
            self.client.get(f"/api/events/{self.ev}/").json()["payload"]["running_since"])

    def test_moving_the_start_back_lengthens_the_running_side(self):
        self.client.post(f"/api/events/{self.ev}/timer/",
                         {"action": "start", "side": "R", "at": self.t0.isoformat()},
                         format="json")
        before = self.running_since()
        earlier = self.t0 - timedelta(minutes=10)
        r = self.client.patch(f"/api/events/{self.ev}/",
                              {"started_at": earlier.isoformat()}, format="json")
        self.assertEqual(r.status_code, 200, r.json())
        # The running segment moved with it, so ten more minutes are on that side.
        self.assertEqual((before - self.running_since()), timedelta(minutes=10))

        # ...and banking it proves the total grew by exactly that much.
        r = self.client.post(f"/api/events/{self.ev}/finish/",
                             {"at": (self.t0 + timedelta(minutes=13)).isoformat()},
                             format="json")
        self.assertEqual(r.json()["payload"]["right_sec"], 23 * 60)

    def test_moving_the_start_forward_shortens_it(self):
        self.client.post(f"/api/events/{self.ev}/timer/",
                         {"action": "start", "side": "L", "at": self.t0.isoformat()},
                         format="json")
        later = self.t0 + timedelta(minutes=5)
        self.client.patch(f"/api/events/{self.ev}/", {"started_at": later.isoformat()},
                          format="json")
        r = self.client.post(f"/api/events/{self.ev}/finish/",
                             {"at": (self.t0 + timedelta(minutes=13)).isoformat()},
                             format="json")
        self.assertEqual(r.json()["payload"]["left_sec"], 8 * 60)

    def test_a_paused_feed_keeps_its_total_when_the_start_moves(self):
        # Nothing was running, so nothing should be added: that stretch was not
        # counted in the first place.
        self.client.post(f"/api/events/{self.ev}/timer/",
                         {"action": "start", "side": "R", "at": self.t0.isoformat()},
                         format="json")
        self.client.post(f"/api/events/{self.ev}/timer/",
                         {"action": "stop", "at": (self.t0 + timedelta(minutes=9)).isoformat()},
                         format="json")
        r = self.client.patch(f"/api/events/{self.ev}/",
                              {"started_at": (self.t0 - timedelta(minutes=30)).isoformat()},
                              format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.assertEqual(r.json()["payload"]["right_sec"], 9 * 60)
        self.assertNotIn("running_since", r.json()["payload"])

    def test_a_finished_feed_is_not_touched_by_this(self):
        self.client.post(f"/api/events/{self.ev}/timer/",
                         {"action": "start", "side": "R", "at": self.t0.isoformat()},
                         format="json")
        self.client.post(f"/api/events/{self.ev}/finish/",
                         {"at": (self.t0 + timedelta(minutes=10)).isoformat()}, format="json")
        r = self.client.patch(f"/api/events/{self.ev}/",
                              {"started_at": (self.t0 - timedelta(minutes=5)).isoformat()},
                              format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.assertEqual(r.json()["payload"]["right_sec"], 10 * 60)


class NursingDurationTests(APITestCase):
    """A nursing feed lasts as long as the timer ran, not start to end."""

    def setUp(self):
        self.user, self.hh, self.baby = make_household("theo-duration")
        self.client.force_authenticate(self.user)
        self.t0 = timezone.now() - timedelta(hours=2)

    def start(self):
        return self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": self.t0.isoformat(), "in_progress": True,
            "payload": {"method": "breast"}}, format="json").json()["id"]

    def tick(self, ev, action, side=None, mins=0):
        body = {"action": action, "at": (self.t0 + timedelta(minutes=mins)).isoformat()}
        if side:
            body["side"] = side
        return self.client.post(f"/api/events/{ev}/timer/", body, format="json")

    def test_a_paused_feed_counts_only_the_nursing(self):
        ev = self.start()
        self.tick(ev, "start", "R", 0)
        self.tick(ev, "stop", mins=4)          # 4 minutes on R
        self.tick(ev, "start", "L", 90)        # ...then an 86 minute gap
        r = self.client.post(f"/api/events/{ev}/finish/",
                             {"at": (self.t0 + timedelta(minutes=105)).isoformat()},
                             format="json")
        self.assertEqual(r.status_code, 200, r.json())
        p = r.json()["payload"]
        self.assertEqual(p["right_sec"], 4 * 60)
        self.assertEqual(p["left_sec"], 15 * 60)
        # 19 minutes of nursing, not the 105 minutes it spanned.
        self.assertEqual(r.json()["duration_sec"], 19 * 60)

    def test_each_stretch_is_recorded_with_its_times(self):
        ev = self.start()
        self.tick(ev, "start", "R", 0)
        self.tick(ev, "stop", mins=4)
        self.tick(ev, "start", "L", 90)
        r = self.client.post(f"/api/events/{ev}/finish/",
                             {"at": (self.t0 + timedelta(minutes=105)).isoformat()},
                             format="json")
        segs = r.json()["payload"]["segments"]
        self.assertEqual([s["side"] for s in segs], ["R", "L"])
        self.assertEqual(parse_datetime(segs[0]["from"]), self.t0)
        self.assertEqual(parse_datetime(segs[1]["from"]), self.t0 + timedelta(minutes=90))
        # The gap between them is the paused stretch the calendar fades out.
        gap = parse_datetime(segs[1]["from"]) - parse_datetime(segs[0]["to"])
        self.assertEqual(gap, timedelta(minutes=86))

    def test_a_bottle_feed_still_uses_wall_clock(self):
        r = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": self.t0.isoformat(),
            "ended_at": (self.t0 + timedelta(minutes=12)).isoformat(),
            "payload": {"method": "bottle", "volume_ml": 100}}, format="json")
        self.assertEqual(r.json()["duration_sec"], 12 * 60)

    def test_sleep_still_uses_wall_clock(self):
        r = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "sleep",
            "started_at": self.t0.isoformat(),
            "ended_at": (self.t0 + timedelta(minutes=95)).isoformat(),
            "payload": {}}, format="json")
        self.assertEqual(r.json()["duration_sec"], 95 * 60)


class SegmentsStayHonestTests(APITestCase):
    """Recorded stretches must never contradict the side totals."""

    def setUp(self):
        self.user, self.hh, self.baby = make_household("theo-segments")
        self.client.force_authenticate(self.user)
        self.t0 = timezone.now() - timedelta(hours=2)
        self.ev = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": self.t0.isoformat(), "in_progress": True,
            "payload": {"method": "breast"}}, format="json").json()["id"]
        for body in [
            {"action": "start", "side": "R", "at": self.t0.isoformat()},
            {"action": "start", "side": "L",
             "at": (self.t0 + timedelta(minutes=12)).isoformat()},
        ]:
            self.client.post(f"/api/events/{self.ev}/timer/", body, format="json")
        self.client.post(f"/api/events/{self.ev}/finish/",
                         {"at": (self.t0 + timedelta(minutes=30)).isoformat()},
                         format="json")

    def payload(self):
        return self.client.get(f"/api/events/{self.ev}/").json()["payload"]

    def test_the_timer_records_stretches_that_match_the_totals(self):
        p = self.payload()
        self.assertEqual(len(p["segments"]), 2)
        spanned = sum(
            (parse_datetime(s["to"]) - parse_datetime(s["from"])).total_seconds()
            for s in p["segments"])
        self.assertAlmostEqual(spanned, (p["right_sec"] + p["left_sec"]), delta=2)

    def test_editing_a_side_drops_the_stale_stretches(self):
        p = self.payload()
        r = self.client.patch(f"/api/events/{self.ev}/", {
            "payload": {**p, "right_sec": 5 * 60, "left_sec": 4 * 60}}, format="json")
        self.assertEqual(r.status_code, 200, r.json())
        # The stretches described the old run, so they go rather than lie.
        self.assertNotIn("segments", r.json()["payload"])
        self.assertEqual(r.json()["duration_sec"], 9 * 60)

    def test_editing_something_else_keeps_the_stretches(self):
        p = self.payload()
        r = self.client.patch(f"/api/events/{self.ev}/",
                              {"notes": "fussy", "payload": p}, format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.assertEqual(len(r.json()["payload"]["segments"]), 2)

    def test_a_feed_ends_when_the_timer_stopped_not_when_save_was_pressed(self):
        # setUp stops L at +30m by finishing there, so extend: stop the timer
        # at +30m, then save ten minutes later.
        t0 = timezone.now() - timedelta(hours=3)
        ev = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": t0.isoformat(), "in_progress": True,
            "payload": {"method": "breast"}}, format="json").json()["id"]
        self.client.post(f"/api/events/{ev}/timer/",
                         {"action": "start", "side": "R", "at": t0.isoformat()},
                         format="json")
        stopped = t0 + timedelta(minutes=20)
        self.client.post(f"/api/events/{ev}/timer/",
                         {"action": "stop", "at": stopped.isoformat()}, format="json")
        r = self.client.post(f"/api/events/{ev}/finish/",
                             {"at": (stopped + timedelta(minutes=10)).isoformat()},
                             format="json")
        self.assertEqual(r.status_code, 200, r.json())
        # Ten minutes of "getting round to saving" is not part of the feed.
        self.assertEqual(parse_datetime(r.json()["ended_at"]), stopped)
        self.assertEqual(r.json()["duration_sec"], 20 * 60)

    def test_a_feed_begins_when_the_timer_did_not_when_the_screen_opened(self):
        # Open the screen at t0, but tap nothing for seven minutes.
        t0 = timezone.now() - timedelta(hours=4)
        ev = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": t0.isoformat(), "in_progress": True,
            "payload": {"method": "breast"}}, format="json").json()["id"]
        first = t0 + timedelta(minutes=7)
        self.client.post(f"/api/events/{ev}/timer/",
                         {"action": "start", "side": "L", "at": first.isoformat()},
                         format="json")
        r = self.client.post(f"/api/events/{ev}/finish/",
                             {"at": (first + timedelta(minutes=12)).isoformat()},
                             format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.assertEqual(parse_datetime(r.json()["started_at"]), first)
        self.assertEqual(r.json()["duration_sec"], 12 * 60)
        # Nothing dead at either end: the block is exactly the nursing.
        self.assertEqual(
            (parse_datetime(r.json()["ended_at"])
             - parse_datetime(r.json()["started_at"])).total_seconds(), 12 * 60)

    def test_moving_the_start_moves_the_whole_feed(self):
        before = self.client.get(f"/api/events/{self.ev}/").json()
        span = (parse_datetime(before["ended_at"])
                - parse_datetime(before["started_at"])).total_seconds()
        moved = parse_datetime(before["started_at"]) - timedelta(minutes=40)
        r = self.client.patch(f"/api/events/{self.ev}/",
                              {"started_at": moved.isoformat()}, format="json")
        self.assertEqual(r.status_code, 200, r.json())
        after = r.json()
        # The pin moved; the shape did not.
        self.assertEqual(parse_datetime(after["started_at"]), moved)
        self.assertEqual(after["duration_sec"], before["duration_sec"])
        self.assertEqual(
            (parse_datetime(after["ended_at"])
             - parse_datetime(after["started_at"])).total_seconds(), span)
        # The stretches came with it rather than leaving a gap at the front.
        self.assertEqual(parse_datetime(after["payload"]["segments"][0]["from"]), moved)

    def test_moving_a_running_feed_s_start_still_lands_in_the_total(self):
        t0 = timezone.now() - timedelta(minutes=30)
        ev = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": t0.isoformat(), "in_progress": True,
            "payload": {"method": "breast"}}, format="json").json()["id"]
        self.client.post(f"/api/events/{ev}/timer/",
                         {"action": "start", "side": "R", "at": t0.isoformat()},
                         format="json")
        r = self.client.patch(f"/api/events/{ev}/",
                              {"started_at": (t0 - timedelta(minutes=10)).isoformat()},
                              format="json")
        self.assertEqual(r.status_code, 200, r.json())
        # The running side gained the ten minutes rather than swallowing them.
        since = parse_datetime(r.json()["payload"]["running_since"])
        self.assertEqual(since, t0 - timedelta(minutes=10))

    def test_a_hand_edited_end_is_pulled_back_to_the_last_stretch(self):
        p = self.payload()
        late = parse_datetime(p["segments"][-1]["to"]) + timedelta(minutes=25)
        r = self.client.patch(f"/api/events/{self.ev}/",
                              {"ended_at": late.isoformat()}, format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.assertEqual(parse_datetime(r.json()["ended_at"]),
                         parse_datetime(p["segments"][-1]["to"]))

    def test_a_feed_with_no_stretches_still_ends_when_saved(self):
        t0 = timezone.now() - timedelta(minutes=10)
        ev = self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "feed",
            "started_at": t0.isoformat(), "in_progress": True,
            "payload": {"method": "breast"}}, format="json").json()["id"]
        at = t0 + timedelta(minutes=5)
        r = self.client.post(f"/api/events/{ev}/finish/", {"at": at.isoformat()},
                             format="json")
        self.assertEqual(parse_datetime(r.json()["ended_at"]), at)


class VoiceParseTests(APITestCase):
    """The parse endpoint proposes; it must never be able to write.

    Every case here stubs the model, so nothing reaches the network and the
    assertions are about what happens to output we choose to be hostile.
    """

    def setUp(self):
        self.user, self.hh, self.baby = make_household("theo-voice")
        self.client.force_authenticate(self.user)

    def stub(self, events):
        return mock.patch("events.parsing._completion",
                          return_value={"events": events})

    def parse(self, text="fed him", **kw):
        return self.client.post("/api/events/parse/", {"text": text, **kw},
                                format="json")

    def a_feed(self, **over):
        row = {"type": "feed", "started_at": timezone.now().isoformat(),
               "ended_at": None, "notes": None,
               "payload": {k: None for k in
                           ["method", "left_sec", "right_sec", "volume_ml",
                            "contents", "pee", "poo", "color", "consistency",
                            "left_ml", "right_ml"]}}
        row["payload"]["method"] = "breast"
        row["payload"]["left_sec"] = 20 * 60
        row.update(over)
        return row

    def test_it_writes_nothing(self):
        before = Event.objects.count()
        with self.stub([self.a_feed()]):
            r = self.parse()
        self.assertEqual(r.status_code, 200, r.json())
        self.assertEqual(r.json()["events"][0]["payload"]["left_sec"], 1200)
        # The whole point: a parse is a draft.
        self.assertEqual(Event.objects.count(), before)

    def test_cross_type_nulls_are_stripped(self):
        # Strict mode forces every key onto every row. `pee: null` on a feed is
        # an unknown key for `feed` and would fail validation if kept.
        with self.stub([self.a_feed()]):
            payload = self.parse().json()["events"][0]["payload"]
        self.assertNotIn("pee", payload)
        self.assertNotIn("left_ml", payload)
        self.assertEqual(self.parse_errors(), [])

    def parse_errors(self):
        with self.stub([self.a_feed()]):
            return self.parse().json()["events"][0]["errors"]

    def test_a_hallucinated_field_never_reaches_the_row(self):
        row = self.a_feed()
        row["payload"]["mood"] = "content"
        with self.stub([row]):
            payload = self.parse().json()["events"][0]["payload"]
        self.assertNotIn("mood", payload)

    def test_server_owned_timer_state_is_refused(self):
        # The dangerous one. `segments` IS a valid feed key as far as
        # validate_payload is concerned, and import_commit builds Event()
        # directly without EventSerializer.validate -- so if the allowlist let
        # this through it would commit unclamped and the calendar would draw
        # stretches nobody timed.
        row = self.a_feed()
        row["payload"]["segments"] = [{"side": "L", "from": "x", "to": "y"}]
        row["payload"]["running_side"] = "L"
        row["payload"]["running_since"] = timezone.now().isoformat()
        with self.stub([row]):
            payload = self.parse().json()["events"][0]["payload"]
        for key in ("segments", "running_side", "running_since"):
            self.assertNotIn(key, payload)

    def test_a_time_in_the_future_is_flagged_not_accepted(self):
        row = self.a_feed(started_at=(timezone.now() + timedelta(days=2000)).isoformat())
        with self.stub([row]):
            ev = self.parse().json()["events"][0]
        self.assertIn("that time is in the future", ev["errors"])

    def test_an_unknown_event_type_is_dropped(self):
        with self.stub([self.a_feed(type="haircut"), self.a_feed()]):
            body = self.parse().json()
        self.assertEqual(len(body["events"]), 1)

    def test_the_side_that_was_nursed_is_derived_not_taken(self):
        with self.stub([self.a_feed()]):
            self.assertEqual(self.parse().json()["events"][0]["payload"]["last_side"], "L")
        both = self.a_feed()
        both["payload"]["right_sec"] = 300
        with self.stub([both]):
            # Ambiguous, so it stays unset rather than being guessed.
            self.assertNotIn("last_side", self.parse().json()["events"][0]["payload"])

    def test_ids_are_content_derived_so_a_retry_upserts(self):
        with self.stub([self.a_feed()]):
            first = self.parse("fed him 20 on the left").json()["events"][0]["id"]
        with self.stub([self.a_feed()]):
            again = self.parse("fed him 20 on the left").json()["events"][0]["id"]
            other = self.parse("wet diaper").json()["events"][0]["id"]
        self.assertEqual(first, again)
        self.assertNotEqual(first, other)

    def test_empty_and_oversized_input_are_refused_before_the_model(self):
        with mock.patch("events.parsing._completion") as called:
            self.assertEqual(self.client.post("/api/events/parse/", {"text": "  "},
                                              format="json").status_code, 400)
            self.assertEqual(self.parse("x" * 5000).status_code, 400)
            called.assert_not_called()

    def test_an_upstream_failure_is_503_not_500(self):
        with mock.patch("events.parsing._completion", side_effect=RuntimeError("boom")):
            self.assertEqual(self.parse().status_code, 503)

    def test_it_needs_authentication(self):
        self.client.force_authenticate(None)
        self.assertIn(self.parse().status_code, (401, 403))


class SpokenFieldsAllowlistTests(APITestCase):
    """The allowlist has to stay honest as the payload schema grows."""

    def test_every_spoken_field_is_a_real_payload_field(self):
        for kind, fields in SPOKEN_FIELDS.items():
            for f in fields:
                self.assertIn(f, PAYLOAD_FIELDS[kind],
                              f"{kind}.{f} is not a real payload field")

    def test_server_owned_fields_are_not_spoken(self):
        for kind, fields in SPOKEN_FIELDS.items():
            for owned in ("segments", "running_side", "running_since"):
                self.assertNotIn(owned, fields)

    def test_the_schema_only_offers_spoken_fields(self):
        offered = set(
            schema()["properties"]["events"]["items"]["properties"]["payload"]["required"])
        allowed = {f for fields in SPOKEN_FIELDS.values() for f in fields}
        self.assertEqual(offered, allowed)


class CrossHouseholdIdTests(APITestCase):
    """Content-derived ids are supplied by the client, so they can collide.

    `import_commit` writes with `update_conflicts=True`, which means an
    unguarded collision does not error -- it silently rewrites somebody else's
    event. That is the failure this class exists to prevent.
    """

    def setUp(self):
        self.a_user, self.a_hh, self.a_baby = make_household("theo-a")
        self.b_user, self.b_hh, self.b_baby = make_household("theo-b")

    def row(self, ident, note):
        return {"id": str(ident), "type": "diaper",
                "started_at": timezone.now().isoformat(), "ended_at": None,
                "tz": "UTC", "payload": {"pee": "small"}, "notes": note}

    def commit(self, user, baby, rows):
        self.client.force_authenticate(user)
        return self.client.post("/api/import/commit/",
                                {"baby": str(baby.pk), "events": rows}, format="json")

    def test_one_household_cannot_overwrite_another_s_event(self):
        shared = uuid.uuid4()
        r = self.commit(self.a_user, self.a_baby, [self.row(shared, "mine")])
        self.assertEqual(r.json()["saved"], 1)

        r = self.commit(self.b_user, self.b_baby, [self.row(shared, "theirs")])
        self.assertEqual(r.json()["saved"], 0)
        self.assertEqual(r.status_code, 400)
        self.assertIn("that id belongs to another household",
                      r.json()["skipped"][0]["errors"])
        # The original is untouched: notes, and crucially the baby it belongs to.
        ev = Event.objects.get(pk=shared)
        self.assertEqual(ev.notes, "mine")
        self.assertEqual(ev.baby_id, self.a_baby.pk)

    def test_a_household_can_still_re_commit_its_own_row(self):
        shared = uuid.uuid4()
        self.commit(self.a_user, self.a_baby, [self.row(shared, "first")])
        r = self.commit(self.a_user, self.a_baby, [self.row(shared, "corrected")])
        self.assertEqual(r.json()["saved"], 1)
        self.assertEqual(Event.objects.get(pk=shared).notes, "corrected")

    def test_a_malformed_id_is_reported_not_a_500(self):
        # 400 because nothing saved, which is the endpoint's existing
        # convention -- the point is that it is reported per row rather than
        # blowing up in the queryset.
        r = self.commit(self.a_user, self.a_baby, [self.row("not-a-uuid", "x")])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["saved"], 0)
        self.assertIn("id must be a UUID", r.json()["skipped"][0]["errors"])

    def test_the_same_sentence_in_two_households_yields_different_ids(self):
        from .parsing import extract_events
        with mock.patch("events.parsing._completion", return_value={"events": [{
                "type": "diaper", "started_at": timezone.now().isoformat(),
                "ended_at": None, "notes": None,
                "payload": {"pee": "small", "poo": None, "color": None,
                            "consistency": None, "method": None, "left_sec": None,
                            "right_sec": None, "volume_ml": None, "contents": None,
                            "left_ml": None, "right_ml": None}}]}):
            kw = dict(tz="UTC", now=timezone.now())
            a = extract_events("wet diaper", scope=self.a_hh.pk, **kw)[0]["id"]
            b = extract_events("wet diaper", scope=self.b_hh.pk, **kw)[0]["id"]
            again = extract_events("wet diaper", scope=self.a_hh.pk, **kw)[0]["id"]
        self.assertNotEqual(a, b, "two households must not mint the same id")
        self.assertEqual(a, again, "the same household must still upsert")


class TenancyScopingTests(APITestCase):
    """Every write path must decide the household server-side.

    One household cannot see, change or delete another's anything -- and the
    destructive paths need the same care as the readable ones.
    """

    def setUp(self):
        self.a_user, self.a_hh, self.a_baby = make_household("scope-a")
        self.b_user, self.b_hh, self.b_baby = make_household("scope-b")
        self.a_event = Event.objects.create(
            household=self.a_hh, baby=self.a_baby, type="diaper",
            started_at=timezone.now(), tz="UTC", payload={"pee": "small"})
        self.client.force_authenticate(self.b_user)   # always the outsider

    def test_another_households_event_is_invisible_and_unwritable(self):
        self.assertEqual(self.client.get(f"/api/events/{self.a_event.pk}/").status_code, 404)
        self.assertEqual(self.client.patch(f"/api/events/{self.a_event.pk}/",
                                           {"notes": "x"}, format="json").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/events/{self.a_event.pk}/").status_code, 404)

    def test_an_event_cannot_be_attached_to_another_households_baby(self):
        r = self.client.post("/api/events/", {
            "baby": str(self.a_baby.pk), "type": "diaper",
            "started_at": timezone.now().isoformat(), "payload": {"pee": "small"}},
            format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("another household", str(r.json()))

    def test_a_baby_cannot_be_read_moved_or_deleted_across_households(self):
        self.assertEqual(self.client.get(f"/api/babies/{self.a_baby.pk}/").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/babies/{self.a_baby.pk}/").status_code, 404)
        # `household` is not a serializer field, so it cannot be reassigned.
        r = self.client.patch(f"/api/babies/{self.b_baby.pk}/",
                              {"household": self.a_hh.pk}, format="json")
        self.assertEqual(r.status_code, 200)
        self.b_baby.refresh_from_db()
        self.assertEqual(self.b_baby.household_id, self.b_hh.pk)

    def test_another_household_is_invisible(self):
        self.assertEqual(self.client.get("/api/households/").json()["count"], 1)
        self.assertEqual(self.client.get(f"/api/households/{self.a_hh.pk}/").status_code, 404)
        self.assertEqual(self.client.patch(f"/api/households/{self.a_hh.pk}/",
                                           {"name": "x"}, format="json").status_code, 404)

    def test_invites_are_scoped(self):
        inv = Invite.objects.create(household=self.a_hh, created_by=self.a_user,
                                    email="x@example.com")
        self.assertEqual(self.client.get(f"/api/invites/{inv.pk}/").status_code, 404)
        self.assertEqual(
            self.client.post(f"/api/invites/{inv.pk}/resend/", {}, format="json").status_code,
            404)

    def test_parse_and_timer_endpoints_refuse_foreign_events(self):
        for path in (f"/api/events/{self.a_event.pk}/timer/",
                     f"/api/events/{self.a_event.pk}/finish/"):
            self.assertEqual(
                self.client.post(path, {"action": "stop"}, format="json").status_code, 404)

    def test_registration_needs_an_invite(self):
        self.client.force_authenticate(None)
        r = self.client.post("/api/auth/register/",
                             {"username": "stranger", "password": "correct-horse-9271"},
                             format="json")
        self.assertEqual(r.status_code, 400)
        # Not open sign-up: without a usable code there is no way in.
        self.assertFalse(User.objects.filter(username="stranger").exists())


class HouseholdWriteSurfaceTests(APITestCase):
    """HouseholdViewSet is a full ModelViewSet. What does that actually expose?"""

    def setUp(self):
        self.user, self.hh, self.baby = make_household("surface")
        Event.objects.create(household=self.hh, baby=self.baby, type="diaper",
                             started_at=timezone.now(), tz="UTC", payload={})
        self.client.force_authenticate(self.user)

    def test_a_household_cannot_be_created_over_the_api(self):
        # It used to 201 and mint one with no members: unreachable by anybody,
        # including whoever made it.
        r = self.client.post("/api/households/", {"name": "orphan"}, format="json")
        self.assertEqual(r.status_code, 405)
        self.assertEqual(Household.objects.count(), 1)

    def test_a_household_cannot_be_deleted_over_the_api(self):
        # It used to 204 and cascade: every baby and every event, on one call.
        r = self.client.delete(f"/api/households/{self.hh.pk}/")
        self.assertEqual(r.status_code, 405)
        self.assertEqual(Baby.objects.count(), 1)
        self.assertEqual(Event.objects.count(), 1)

    def test_the_household_is_still_editable(self):
        r = self.client.patch(f"/api/households/{self.hh.pk}/",
                              {"feed_interval_min": 150}, format="json")
        self.assertEqual(r.status_code, 200, r.json())
        self.hh.refresh_from_db()
        self.assertEqual(self.hh.feed_interval_min, 150)


class SleepTimerTests(APITestCase):
    """A sleep is a timer with no sides: start it, finish it, and it must not
    fork any more readily than a feed does."""

    def setUp(self):
        self.user, self.hh, self.baby = make_household("theo-sleep")
        self.client.force_authenticate(self.user)

    def start(self, kind="sleep"):
        return self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": kind,
            "started_at": timezone.now().isoformat(), "in_progress": True,
            "payload": {"method": "breast"} if kind == "feed" else {}}, format="json")

    def test_finish_closes_it_without_any_timer_intents(self):
        ev = self.start().json()
        r = self.client.post(f"/api/events/{ev['id']}/finish/", {}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["in_progress"])
        self.assertIsNotNone(r.json()["ended_at"])
        # No segments, so the span is start..finish rather than nothing at all.
        self.assertEqual(r.json()["started_at"], ev["started_at"])

    def test_a_second_start_returns_the_running_sleep(self):
        first = self.start()
        second = self.start()
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["id"], first.json()["id"])
        self.assertEqual(Event.objects.filter(type="sleep").count(), 1)

    def test_a_sleep_can_start_while_a_feed_runs(self):
        feed = self.start("feed")
        sleep = self.start()
        self.assertEqual(sleep.status_code, 201)
        self.assertNotEqual(sleep.json()["id"], feed.json()["id"])
        self.assertEqual(len(self.client.get("/api/events/active/").json()["events"]), 2)


class CustomEventTests(APITestCase):
    """The free-form event: a title is the whole point of it."""

    def setUp(self):
        self.user, self.hh, self.baby = make_household("theo-note")
        self.client.force_authenticate(self.user)

    def post(self, payload):
        return self.client.post("/api/events/", {
            "baby": str(self.baby.pk), "type": "note",
            "started_at": timezone.now().isoformat(),
            "payload": payload}, format="json")

    def test_a_note_carries_a_label(self):
        r = self.post({"label": "Vitamin D"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["payload"]["label"], "Vitamin D")

    def test_unknown_note_keys_are_still_rejected(self):
        self.assertEqual(self.post({"dose": 400}).status_code, 400)

    def test_the_parser_may_title_a_note(self):
        self.assertIn("label", SPOKEN_FIELDS[Event.NOTE])
        self.assertIn("label", schema()["properties"]["events"]["items"]
                      ["properties"]["payload"]["properties"])
